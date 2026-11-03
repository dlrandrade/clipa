import { cfg } from './config.js';

const SYSTEM = `You are a senior editor of viral short-form video (TikTok, Reels, YouTube Shorts).
You receive the transcript of a long video split into numbered sentences, and you cut clips that work
as standalone videos for a stranger scrolling the feed.

The #1 rule: every clip is ONE COMPLETE THOUGHT, with a beginning, a middle and an end.
- Beginning: the clip opens where the idea starts (a question, a bold claim, a story opener, the topic being introduced).
  Never open on a sentence that depends on earlier context: starting with connectors ("and", "so", "but", "that's why",
  "e", "então", "aí", "mas", "por isso", "isso", "porque", "tipo"), pronouns pointing back ("this", "that", "isso", "ele", "ela"),
  or an answer to a question asked earlier (include the question instead).
- End: the clip closes when the idea is resolved (the conclusion, lesson, answer, punchline or reveal).
  Never end on a setup, in the middle of a list or argument, or on a sentence that opens the next topic.
- If a great idea does not fit in the allowed duration, pick another moment instead of chopping it.
- Prefer strong hooks in the first 3 seconds and a clear payoff. Skip greetings, housekeeping, sponsor reads and rambling.

Write "title" and "hook" in the SAME LANGUAGE as the transcript.
Return ONLY a JSON array, no prose, no markdown fences.`;

// ---------- utilidades ----------

const nearest = (arr, value) => {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < arr.length; i++) {
    const d = Math.abs(arr[i] - value);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
};

/** Ajusta início/fim para limites de frases (segmentos) e respeita duração mínima/máxima. */
export function snap(segments, start, end, { min, max, duration }) {
  if (!segments.length) return null;
  const i = nearest(segments.map((s) => s.start), start);
  let j = nearest(segments.map((s) => s.end), end);
  if (j < i) j = i;
  while (j > i && segments[j].end - segments[i].start > max) j--;
  while (j < segments.length - 1 && segments[j].end - segments[i].start < min) j++;
  const s = segments[i].start;
  const e = segments[j].end;
  if (e - s > max * 1.15 || e - s < min * 0.8) return null;
  return { start: Math.max(0, s - 0.15), end: Math.min(duration, e + 0.25) };
}

const overlap = (a, b) => {
  const inter = Math.min(a.end, b.end) - Math.max(a.start, b.start);
  if (inter <= 0) return 0;
  return inter / Math.min(a.end - a.start, b.end - b.start);
};

export function finalize(cands, segments, { count, min, max, duration }) {
  const snapped = [];
  for (const c of cands) {
    if (![c.start, c.end, c.score].every(Number.isFinite)) continue;
    const t = snap(segments, c.start, c.end, { min, max, duration });
    if (!t) continue;
    snapped.push({ ...c, start: t.start, end: t.end, score: Math.max(0, Math.min(100, Math.round(c.score))) });
  }
  snapped.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const c of snapped) {
    if (picked.some((p) => overlap(p, c) > 0.25)) continue;
    picked.push(c);
    if (picked.length >= count) break;
  }
  return picked.map((c, i) => ({ ...c, rank: i + 1 }));
}

// ---------- frases ----------

const TERMINAL = /[.?!…]["”'»)]?$/;

/**
 * Transforma os segmentos do Whisper (que cortam no meio da frase) em FRASES de verdade,
 * com tempo de início/fim tirado das palavras. É a unidade de corte: clipe começa e termina em frase.
 */
export function buildSentences({ segments = [], words = [] }) {
  const pieces = [];
  let wi = 0;
  for (const seg of segments) {
    const parts = (seg.text.match(/[^.?!…]+[.?!…]+["”'»)]?|[^.?!…]+$/g) || [seg.text]).map((p) => p.trim()).filter(Boolean);
    const segWords = [];
    while (wi < words.length && words[wi].start < seg.end - 0.01) {
      if (words[wi].end > seg.start - 0.5) segWords.push(words[wi]);
      wi++;
    }
    const counts = parts.map((p) => p.split(/\s+/).filter(Boolean).length);
    const total = counts.reduce((a, b) => a + b, 0);
    let acc = 0;
    parts.forEach((text, k) => {
      const n = counts[k];
      if (!n) return;
      let start;
      let end;
      if (segWords.length === total) {
        start = segWords[acc].start;
        end = segWords[acc + n - 1].end;
      } else {
        const d = seg.end - seg.start;
        start = seg.start + (d * acc) / total;
        end = seg.start + (d * (acc + n)) / total;
      }
      acc += n;
      pieces.push({ start, end, text, terminal: TERMINAL.test(text) });
    });
  }
  // junta pedaços sem pontuação final com o próximo (frase que atravessa dois segmentos)
  const out = [];
  let cur = null;
  for (const p of pieces) {
    if (!cur) cur = { ...p };
    else {
      cur.end = p.end;
      cur.text += ' ' + p.text;
      cur.terminal = p.terminal;
    }
    if (cur.terminal || cur.end - cur.start > 40) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out.map((s, id) => ({ id, start: s.start, end: s.end, text: s.text }));
}

// ---------- heurística (funciona sem chave de LLM) ----------

const HOOK_RE = /\b(segredo|erro|nunca|sempre|ninguém|verdade|dinheiro|milh(ão|ões)|como|por que|porque|why|how|never|secret|mistake|truth|money|million|biggest|worst|best)\b/i;
// frases que dependem do que veio antes: não servem para abrir um clipe
const DEPENDENT_RE = /^(e|é|então|aí|daí|mas|porém|por isso|isso|essa|esse|isto|ele|ela|eles|elas|porque|pois|tipo|né|também|ou seja|ainda|só que|and|so|but|that|this|it|because|also|which|then)(?=[\s,.!?;:]|$)/i;

function heurScore(text, dur) {
  const words = text.split(/\s+/).length;
  const density = Math.min(1, words / dur / 3); // ~3 palavras/s = fala densa
  const q = (text.match(/\?/g) || []).length;
  const ex = (text.match(/!/g) || []).length;
  const nums = (text.match(/\d+/g) || []).length;
  const hook = HOOK_RE.test(text.slice(0, 160)) ? 1 : 0;
  const s = 38 + density * 22 + Math.min(q, 3) * 4 + Math.min(ex, 3) * 3 + Math.min(nums, 4) * 2 + hook * 8;
  return Math.min(92, s);
}

export function heuristicCandidates(sents, { min, max }) {
  const out = [];
  const target = Math.min(max, Math.max(min, 45));
  for (let i = 0; i < sents.length; i++) {
    const first = sents[i].text.replace(/\s+/g, ' ').trim();
    if (DEPENDENT_RE.test(first) || first.split(' ').length < 4) continue;
    let j = i;
    while (j < sents.length - 1 && sents[j].end - sents[i].start < target) j++;
    const dur = sents[j].end - sents[i].start;
    if (dur < min || dur > max * 1.15) continue;
    const text = sents.slice(i, j + 1).map((s) => s.text).join(' ');
    out.push({
      start: sents[i].start,
      end: sents[j].end,
      score: heurScore(text, dur) * 0.7, // LLM tem prioridade
      title: first.length > 60 ? first.slice(0, 57).trimEnd() + '…' : first,
      hook: first,
      reason: 'Selecionado por heurística (sem IA configurada): começa numa frase independente e fecha numa frase completa.',
    });
  }
  return out;
}

// ---------- LLM ----------

function makeWindows(segments, { maxChars = 110000, windowSec = 1800, overlapSec = 120 } = {}) {
  const total = segments.reduce((n, s) => n + s.text.length + 10, 0);
  if (total <= maxChars) return [segments];
  const end = segments[segments.length - 1].end;
  const wins = [];
  for (let t = 0; t < end; t += windowSec) {
    const w = segments.filter((s) => s.end > t - overlapSec && s.start < t + windowSec + overlapSec);
    if (w.length) wins.push(w);
  }
  return wins;
}

const fmt = (sents) => sents.map((s) => `#${s.id} [${Math.round(s.start)}-${Math.round(s.end)}s] ${s.text}`).join('\n');

function extractJsonArray(text) {
  const a = text.indexOf('[');
  const b = text.lastIndexOf(']');
  if (a < 0 || b < a) throw new Error('Resposta do LLM sem JSON.');
  return JSON.parse(text.slice(a, b + 1));
}

async function callClaude(prompt) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': cfg.llm.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: cfg.llm.model,
        max_tokens: 8192,
        system: SYSTEM,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (res.ok) {
      const j = await res.json();
      return j.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
    }
    const body = await res.text();
    lastErr = new Error(`LLM falhou (${res.status}): ${body.slice(0, 300)}`);
    if (res.status !== 429 && res.status < 500) throw lastErr;
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
  throw lastErr;
}

// ---------- OpenRouter (modelos gratuitos em rodízio) ----------

const bad = new Map(); // nome do provedor -> timestamp até quando fica de molho
let freeCache = { at: 0, models: [] };

const hasLlm = () => !!(cfg.llm.apiKey || cfg.gemini.apiKey || cfg.openrouter.apiKey);
const bigContext = () => !!(cfg.llm.apiKey || cfg.gemini.apiKey);

// ---------- Gemini (Google AI Studio; tem cota gratuita) ----------

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
let geminiCache = { at: 0, models: [] };

/** Descobre os modelos "flash" de texto disponíveis para a chave, mais novos primeiro. */
async function geminiModels() {
  if (cfg.gemini.model) return [cfg.gemini.model];
  if (Date.now() - geminiCache.at < 3600_000 && geminiCache.models.length) return geminiCache.models;
  const res = await fetch(`${GEMINI}/models?pageSize=200`, {
    headers: { 'x-goog-api-key': cfg.gemini.apiKey },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Gemini /models falhou (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const { models = [] } = await res.json();
  const ver = (id) => parseFloat((/gemini-(\d+(?:\.\d+)?)/.exec(id) || [])[1] || 0);
  const ids = models
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .filter((id) => /^gemini-[\d.]+-flash/.test(id))
    .filter((id) => !/(live|tts|image|audio|transcribe|embedding|exp|preview|thinking)/.test(id))
    .sort((a, b) => ver(b) - ver(a) || (/lite/.test(a) ? 1 : 0) - (/lite/.test(b) ? 1 : 0))
    .slice(0, 3);
  if (!ids.length) throw new Error('Nenhum modelo Gemini flash disponível para esta chave.');
  geminiCache = { at: Date.now(), models: ids };
  return ids;
}

async function callGemini(model, prompt) {
  const res = await fetch(`${GEMINI}/openai/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.gemini.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(240000),
  });
  if (!res.ok) {
    const e = new Error(`Gemini ${model} falhou (${res.status}): ${(await res.text()).slice(0, 200)}`);
    e.status = res.status;
    throw e;
  }
  const j = await res.json();
  const text = j.choices?.[0]?.message?.content;
  if (!text) throw new Error(`Gemini ${model} voltou vazio`);
  return text;
}

/** Lista os modelos ":free" de texto com contexto grande o bastante, maiores primeiro. */
async function openRouterModels() {
  if (cfg.openrouter.models.length) return cfg.openrouter.models;
  if (Date.now() - freeCache.at < 3600_000 && freeCache.models.length) return freeCache.models;
  const res = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`OpenRouter /models falhou (${res.status})`);
  const { data } = await res.json();
  const models = data
    .filter((m) => m.id.endsWith(':free'))
    .filter((m) => (m.context_length || 0) >= 64000)
    .filter((m) => !m.architecture?.output_modalities || m.architecture.output_modalities.includes('text'))
    .sort((a, b) => b.context_length - a.context_length)
    .slice(0, cfg.openrouter.maxModels)
    .map((m) => m.id);
  if (!models.length) throw new Error('Nenhum modelo gratuito encontrado no OpenRouter agora.');
  freeCache = { at: Date.now(), models };
  return models;
}

async function callOpenRouter(model, prompt) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.openrouter.apiKey}`,
      'content-type': 'application/json',
      'X-Title': 'Clipa',
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      max_tokens: 4096,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) {
    const e = new Error(`OpenRouter ${model} falhou (${res.status}): ${(await res.text()).slice(0, 200)}`);
    e.status = res.status;
    throw e;
  }
  const j = await res.json();
  const text = j.choices?.[0]?.message?.content;
  if (!text) throw new Error(`OpenRouter ${model} voltou vazio`);
  return text;
}

async function providers() {
  const list = [];
  if (cfg.llm.apiKey) list.push({ name: `claude:${cfg.llm.model}`, call: (p) => callClaude(p) });
  if (cfg.gemini.apiKey) {
    try {
      for (const m of await geminiModels()) list.push({ name: `gemini:${m}`, call: (p) => callGemini(m, p) });
    } catch (e) {
      console.warn('[score]', e.message);
    }
  }
  if (cfg.openrouter.apiKey) {
    try {
      for (const m of await openRouterModels()) list.push({ name: `openrouter:${m}`, call: (p) => callOpenRouter(m, p) });
    } catch (e) {
      console.warn('[score]', e.message);
    }
  }
  const ready = list.filter((p) => (bad.get(p.name) || 0) < Date.now());
  return ready.length ? ready : list; // se todos estão de molho, tenta de novo mesmo assim
}

/** Tenta cada provedor em ordem; se falhar (erro, limite, JSON ruim), passa para o próximo. */
async function askLlm(prompt, parse) {
  const errors = [];
  for (const p of await providers()) {
    try {
      const out = parse(await p.call(prompt));
      console.log(`[score] ok com ${p.name}`);
      return out;
    } catch (e) {
      const cool = e.status === 429 || e.status === 402 ? 120_000 : e.status === 404 || e.status === 400 ? 900_000 : 30_000;
      bad.set(p.name, Date.now() + cool);
      errors.push(`${p.name}: ${String(e.message).slice(0, 120)}`);
      console.warn(`[score] ${p.name} falhou, tentando o próximo…`);
    }
  }
  throw new Error(`Todos os modelos falharam. ${errors.join(' | ')}`);
}


const clean = (c) => ({
  title: String(c.title || '').slice(0, 90),
  hook: String(c.hook || ''),
  reason: String(c.reason || ''),
  score: Number(c.score),
});

/** 1ª passada: o LLM escolhe trechos indicando a frase inicial e a final. */
async function llmCandidates(win, byId, { want, min, max }) {
  const prompt = `Pick the ${want} best clips from this transcript.
The transcript is split into numbered sentences: "#id [start-end seconds] text".
A clip is a contiguous run of sentences, from sentence "first" to sentence "last" (ids, inclusive),
lasting between ${min} and ${max} seconds in total. Remember: one complete thought, from where the idea starts to where it is resolved.

Return a JSON array of objects with exactly these keys:
- "first": id of the first sentence
- "last": id of the last sentence
- "title": short punchy title (max 70 chars)
- "hook": the opening line or idea that grabs attention
- "score": integer 0-100, predicted virality (be discriminating; most clips should NOT be above 85)
- "reason": one sentence on what the complete thought is and why it works

TRANSCRIPT:
${fmt(win)}`;
  return askLlm(prompt, (text) => {
    const out = [];
    for (const c of extractJsonArray(text)) {
      const a = byId.get(Number(c.first));
      const b = byId.get(Number(c.last));
      const x = clean(c);
      if (!a || !b || b.id < a.id || !Number.isFinite(x.score)) continue;
      out.push({ ...x, first: a.id, last: b.id, start: a.start, end: b.end });
    }
    if (!out.length) throw new Error('JSON sem trechos válidos');
    return out;
  });
}

/**
 * 2ª passada (revisão): o LLM vê cada rascunho com frases antes e depois, ajusta início/fim para fechar
 * o pensamento e descarta o que não se sustenta sozinho.
 */
async function reviewCandidates(cands, sents, { min, max }) {
  const blocks = cands.map((c, k) => {
    const ctx = sents.filter((s) => s.end >= c.start - 75 && s.start <= c.end + 75);
    return `DRAFT ${k + 1} (currently #${c.first} to #${c.last}, "${c.title}"):\n${fmt(ctx)}`;
  });
  const prompt = `Review these draft clips. Each draft shows its sentences plus some sentences before and after it.
For each draft:
1. Adjust "first" and "last" (sentence ids from that draft's list) so the clip is ONE complete, self-contained thought:
   it opens where the idea starts and closes where it is resolved. Total length between ${min} and ${max} seconds.
2. "keep": false if, even adjusted, a stranger would need outside context to understand it, or it has no payoff.
3. Re-score honestly and rewrite title/hook/reason if needed.

Return a JSON array with one object per draft: {"draft": number, "first": id, "last": id, "keep": boolean,
"score": 0-100, "title": string, "hook": string, "reason": string}

${blocks.join('\n\n')}`;
  const byId = new Map(sents.map((s) => [s.id, s]));
  return askLlm(prompt, (text) => {
    const res = extractJsonArray(text);
    if (!Array.isArray(res) || !res.length) throw new Error('revisão vazia');
    const out = [];
    cands.forEach((c, k) => {
      const r = res.find((x) => Number(x.draft) === k + 1);
      if (!r) return out.push(c); // sem resposta para este: mantém como estava
      if (r.keep === false) return; // descartado pela revisão
      const a = byId.get(Number(r.first));
      const b = byId.get(Number(r.last));
      const x = clean(r);
      const dur = a && b ? b.end - a.start : 0;
      if (!a || !b || b.id < a.id || dur < min * 0.8 || dur > max * 1.15) return out.push(c);
      out.push({ ...c, ...x, score: Number.isFinite(x.score) ? x.score : c.score, first: a.id, last: b.id, start: a.start, end: b.end, reviewed: true });
    });
    return out;
  });
}

/**
 * Escolhe os N melhores momentos.
 * Com IA (Claude, Gemini ou OpenRouter): escolhe por frases + revisão de início/fim.
 * Sem IA: heurística que respeita frases.
 */
export async function pickClips(transcript, duration, { count = cfg.clipCount, min = cfg.minSec, max = cfg.maxSec, onProgress } = {}) {
  const sents = buildSentences(transcript);
  if (!sents.length) return [];
  const byId = new Map(sents.map((s) => [s.id, s]));
  let cands = [];
  let usedLlm = false;

  if (hasLlm()) {
    try {
      // modelos gratuitos do OpenRouter têm contexto menor: janelas menores quando é só ele
      const wins = makeWindows(sents, { maxChars: bigContext() ? 110000 : 60000 });
      const want = wins.length === 1 ? count + 4 : Math.max(4, Math.ceil((count * 2) / wins.length));
      for (let k = 0; k < wins.length; k++) {
        cands.push(...(await llmCandidates(wins[k], byId, { want, min, max })));
        onProgress?.(((k + 1) / wins.length) * 0.7);
      }
      usedLlm = true;
      // revisão só dos melhores (economiza cota)
      const top = finalize(cands, sents, { count: count + 4, min, max, duration });
      try {
        cands = await reviewCandidates(top, sents, { min, max });
        console.log(`[score] revisão: ${top.length} rascunhos → ${cands.length} aprovados`);
      } catch (e) {
        console.warn('[score] revisão indisponível, usando a 1ª escolha:', e.message);
        cands = top;
      }
      onProgress?.(1);
    } catch (e) {
      console.warn('[score] IA indisponível, usando heurística:', e.message);
      cands = [];
      usedLlm = false;
    }
  }
  if (!usedLlm) cands.push(...heuristicCandidates(sents, { min, max }));
  const clips = finalize(cands, sents, { count, min, max, duration });
  return clips.map((c) => ({ ...c, source: usedLlm ? 'llm' : 'heuristic' }));
}
