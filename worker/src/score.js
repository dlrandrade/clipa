import { cfg } from './config.js';

const SYSTEM = `You are a senior editor of viral short-form video (TikTok, Reels, YouTube Shorts).
You receive a timestamped transcript of a long video and pick the moments most likely to stop the scroll
and be watched to the end as standalone clips.

What makes a great clip:
- A strong hook in the first 3 seconds (bold claim, surprising fact, question, tension, story opener).
- Self-contained: makes sense with zero context from the rest of the video.
- Emotional or intellectual payoff before it ends (insight, punchline, reveal, strong opinion, useful tip).
- Starts at the beginning of a sentence and ends at the end of a sentence. Never cut mid-thought.
- Tight pacing: no long rambling, filler, greetings, sponsor reads or housekeeping.

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

// ---------- heurística (funciona sem chave de LLM) ----------

const HOOK_RE = /\b(segredo|erro|nunca|sempre|ninguém|verdade|dinheiro|milh(ão|ões)|como|por que|porque|why|how|never|secret|mistake|truth|money|million|biggest|worst|best)\b/i;

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

export function heuristicCandidates(segments, { min }) {
  const out = [];
  for (let i = 0; i < segments.length; i++) {
    let j = i;
    while (j < segments.length - 1 && segments[j].end - segments[i].start < 45) j++;
    const dur = segments[j].end - segments[i].start;
    if (dur < min) continue;
    const text = segments.slice(i, j + 1).map((s) => s.text).join(' ');
    const first = segments[i].text.replace(/\s+/g, ' ').trim();
    out.push({
      start: segments[i].start,
      end: segments[j].end,
      score: heurScore(text, dur) * 0.7, // LLM tem prioridade
      title: first.length > 60 ? first.slice(0, 57).trimEnd() + '…' : first,
      hook: first,
      reason: 'Selecionado por heurística (densidade de fala, perguntas, números, gancho).',
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

const fmt = (segments) => segments.map((s) => `[${Math.round(s.start)}] ${s.text}`).join('\n');

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
        max_tokens: 4096,
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

const hasLlm = () => !!(cfg.llm.apiKey || cfg.openrouter.apiKey);

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

async function llmCandidates(segments, { want, min, max }) {
  const prompt = `Pick the ${want} best clips from this transcript.
Each clip must last between ${min} and ${max} seconds. Timestamps in brackets are seconds from the start of the video.

Return a JSON array of objects with exactly these keys:
- "start": number (seconds, start of a sentence)
- "end": number (seconds, end of a sentence)
- "title": short punchy title (max 70 chars)
- "hook": the opening line or idea that grabs attention
- "score": integer 0-100, predicted virality (be discriminating; most clips should NOT be above 85)
- "reason": one sentence on why it works

TRANSCRIPT:
${fmt(segments)}`;
  return askLlm(prompt, (text) => {
    const out = extractJsonArray(text)
      .map((c) => ({
        start: Number(c.start),
        end: Number(c.end),
        score: Number(c.score),
        title: String(c.title || '').slice(0, 90),
        hook: String(c.hook || ''),
        reason: String(c.reason || ''),
      }))
      .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start && Number.isFinite(c.score));
    if (!out.length) throw new Error('JSON sem trechos válidos');
    return out;
  });
}

/**
 * Escolhe os N melhores momentos. Usa o LLM quando há ANTHROPIC_API_KEY;
 * sempre completa com heurística caso falte candidato.
 */
export async function pickClips(transcript, duration, { count = cfg.clipCount, min = cfg.minSec, max = cfg.maxSec, onProgress } = {}) {
  const segments = transcript.segments;
  if (!segments.length) return [];
  let cands = [];
  let usedLlm = false;

  if (hasLlm()) {
    try {
      // modelos gratuitos têm contexto/limite menores: janelas menores quando não há Claude
      const wins = makeWindows(segments, { maxChars: cfg.llm.apiKey ? 110000 : 60000 });
      const want = wins.length === 1 ? count + 4 : Math.max(4, Math.ceil((count * 2) / wins.length));
      for (let k = 0; k < wins.length; k++) {
        cands.push(...(await llmCandidates(wins[k], { want, min, max })));
        onProgress?.((k + 1) / wins.length);
      }
      usedLlm = true;
    } catch (e) {
      console.warn('[score] LLM indisponível, usando heurística:', e.message);
      cands = [];
    }
  }
  cands.push(...heuristicCandidates(segments, { min }));
  const clips = finalize(cands, segments, { count, min, max, duration });
  return clips.map((c) => ({ ...c, source: usedLlm && !c.reason.startsWith('Selecionado por heurística') ? 'llm' : 'heuristic' }));
}
