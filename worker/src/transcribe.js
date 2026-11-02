import fs from 'node:fs/promises';
import path from 'node:path';
import { cfg } from './config.js';
import { run, probe } from './ffmpeg.js';

const CHUNK_SEC = 1200; // 20 min por pedaço => ~4.8 MB a 32 kbps, bem abaixo do limite de 25 MB

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callApi(file, language) {
  const { baseUrl, apiKey, model } = cfg.transcribe;
  const form = new FormData();
  form.append('file', await fs.openAsBlob(file), path.basename(file));
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('timestamp_granularities[]', 'segment');
  if (language) form.append('language', language);

  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      if (res.ok) return await res.json();
      const body = await res.text();
      lastErr = new Error(`Transcrição falhou (${res.status}): ${body.slice(0, 300)}`);
      if (res.status !== 429 && res.status < 500) throw lastErr;
    } catch (e) {
      lastErr = e;
      if (/\(4\d\d\)/.test(String(e.message)) && !/\(429\)/.test(String(e.message))) throw e;
    }
    await sleep(1500 * 2 ** attempt);
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
 * Retorna { language, segments: [{start,end,text}], words: [{w,start,end}] }
 */
export async function transcribe(mediaPath, workdir, { language, onProgress } = {}) {
  if (!cfg.transcribe.apiKey) {
    throw new Error('Falta a chave de transcrição. Defina TRANSCRIBE_API_KEY (ou OPENAI_API_KEY) no .env do worker.');
  }
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
  for (let i = 0; i < files.length; i++) {
    const file = path.join(workdir, files[i]);
    const { duration } = await probe(file);
    const r = await callApi(file, language);
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
