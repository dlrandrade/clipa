import { openAsBlob } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { cfg } from './config.js';
import { run, probe } from './ffmpeg.js';

const CHUNK_SEC = 1200; // 20 min por pedaço => ~4.8 MB a 32 kbps, bem abaixo do limite de 25 MB
const MAX_WAIT_MS = 15 * 60_000; // espera máxima por pedido quando o limite estoura

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Tempo que a API pede para esperar (header Retry-After ou "try again in 5m7s"). */
export function retryDelayMs(res, bodyText) {
  const h = parseFloat(res.headers?.get?.('retry-after'));
  if (Number.isFinite(h)) return h * 1000;
  const m = /try again in\s*(?:(\d+)m)?\s*(?:(\d+(?:\.\d+)?)s)?/i.exec(bodyText || '');
  if (m && (m[1] || m[2])) return ((+m[1] || 0) * 60 + (+m[2] || 0)) * 1000;
  return null;
}

async function callApi(file, language, log) {
  const { baseUrl, apiKey, model } = cfg.transcribe;
  const form = new FormData();
  form.append('file', await openAsBlob(file), path.basename(file));
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('timestamp_granularities[]', 'segment');
  if (language) form.append('language', language);

  let lastErr;
  for (let attempt = 0; attempt < 8; attempt++) {
    let wait = 1500 * 2 ** Math.min(attempt, 4);
    let res;
    try {
      res = await fetch(`${baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
    } catch (e) {
      lastErr = e; // erro de rede
      if (attempt >= 3) throw e;
      await sleep(wait);
      continue;
    }
    if (res.ok) return await res.json();

    const body = await res.text();
    lastErr = new Error(`Transcrição falhou (${res.status}): ${body.slice(0, 300)}`);
    if (res.status === 429) {
      // limite de uso: espera o tempo que a própria API pediu (até 15 min) em vez de desistir
      wait = Math.min((retryDelayMs(res, body) ?? wait) + 2000, MAX_WAIT_MS);
      log?.(`Limite da API de transcrição atingido. Esperando ${Math.round(wait / 1000)}s…`);
    } else if (res.status < 500 || attempt >= 3) {
      throw lastErr;
    }
    await sleep(wait);
  }
  throw lastErr;
}

/** Distribui as palavras de cada segmento proporcionalmente ao tamanho (fallback sem word timestamps). */
export function wordsFromSegments(segments) {
  const words = [];
  for (const seg of segments) {
    const toks = seg.text.trim().split(/\s+/).filter(Boolean);
    if (!toks.length) continue;
    const total = toks.reduce((n, t) => n + t.length + 1, 0);
    let cur = seg.start;
    for (const t of toks) {
      const d = ((t.length + 1) / total) * (seg.end - seg.start);
      words.push({ w: t, start: cur, end: cur + d });
      cur += d;
    }
  }
  return words;
}

/**
 * Extrai o áudio, divide em pedaços, transcreve e junta tudo com timestamps absolutos.
 * Com `cacheDir`, cada pedaço transcrito fica salvo em disco: se o job for repetido (erro depois,
 * "Tentar de novo"), não gasta a cota da API de novo.
 * Retorna { language, segments: [{start,end,text}], words: [{w,start,end}] }
 */
export async function transcribe(mediaPath, workdir, { language, onProgress, cacheDir, log } = {}) {
  if (!cfg.transcribe.apiKey) {
    throw new Error('Falta a chave de transcrição. Defina TRANSCRIBE_API_KEY (ou OPENAI_API_KEY) no .env do worker.');
  }
  if (cacheDir) await fs.mkdir(cacheDir, { recursive: true });

  await run('ffmpeg', [
    '-y', '-v', 'error',
    '-i', mediaPath,
    '-vn', '-ac', '1', '-ar', '16000',
    '-c:a', 'libmp3lame', '-b:a', '32k',
    '-f', 'segment', '-segment_time', String(CHUNK_SEC), '-reset_timestamps', '1',
    path.join(workdir, 'audio_%03d.mp3'),
  ]);
  const files = (await fs.readdir(workdir)).filter((f) => /^audio_\d+\.mp3$/.test(f)).sort();
  if (!files.length) throw new Error('Não consegui extrair áudio deste arquivo.');

  const segments = [];
  const words = [];
  let offset = 0;
  let lang = language;
  const tag = `${cfg.transcribe.model}_${language || 'auto'}`.replace(/[^\w.-]+/g, '_');

  for (let i = 0; i < files.length; i++) {
    const file = path.join(workdir, files[i]);
    const { duration } = await probe(file);

    const cacheFile = cacheDir ? path.join(cacheDir, `chunk_${String(i).padStart(3, '0')}_${tag}.json`) : null;
    let r = cacheFile ? await fs.readFile(cacheFile, 'utf8').then(JSON.parse).catch(() => null) : null;
    if (!r) {
      r = await callApi(file, language, log);
      if (cacheFile) await fs.writeFile(cacheFile, JSON.stringify(r));
    }
    lang = lang || r.language;

    const segs = (r.segments || [])
      .map((s) => ({ start: s.start + offset, end: s.end + offset, text: String(s.text || '').trim() }))
      .filter((s) => s.text);
    segments.push(...segs);

    const ws = (r.words || []).map((x) => ({
      w: String(x.word ?? x.w ?? '').trim(),
      start: x.start + offset,
      end: x.end + offset,
    }));
    words.push(...(ws.length ? ws.filter((x) => x.w) : wordsFromSegments(segs)));

    offset += duration;
    onProgress?.((i + 1) / files.length);
    await fs.rm(file, { force: true });
  }
  return { language: lang || null, segments, words };
}
