// Teste de ponta a ponta SEM APIs externas: vídeo sintético + transcrição falsa.
// Verifica: escolha por heurística, corte 9:16 (1080x1920), legendas ASS, thumbnail e áudio-only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run, probe } from '../src/ffmpeg.js';
import { processMedia } from '../src/pipeline.js';
import { buildAss } from '../src/captions.js';
import { snap } from '../src/score.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'clipa-test-'));
const video = path.join(tmp, 'src.mp4');
const audio = path.join(tmp, 'src.mp3');

// 120s de vídeo 16:9 + tom de áudio
await run('ffmpeg', [
  '-y', '-v', 'error',
  '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=25:d=120',
  '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=44100:duration=120',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', video,
]);
await run('ffmpeg', ['-y', '-v', 'error', '-i', video, '-vn', '-c:a', 'libmp3lame', audio]);

// Transcrição falsa: frases de ~5s, palavra a palavra
const phrases = [
  'Ninguém te conta a verdade sobre esse erro que custa dinheiro.',
  'Eu perdi 50 mil reais por causa disso, e você pode evitar!',
  'Por que isso acontece com quase todo mundo que começa?',
  'A resposta é simples, mas quase ninguém aplica no dia a dia.',
];
const segments = [];
const words = [];
let t = 0;
for (let i = 0; i < 24; i++) {
  const text = phrases[i % phrases.length];
  const toks = text.split(' ');
  const seg = { start: t, end: t + 5, text };
  segments.push(seg);
  toks.forEach((w, k) => words.push({ w, start: t + (k / toks.length) * 4.8, end: t + ((k + 1) / toks.length) * 4.8 }));
  t += 5;
}
const transcript = { language: 'pt', segments, words };

// 1) snap respeita limites de frase e duração
const s = snap(segments, 12.3, 70, { min: 20, max: 75, duration: 120 });
assert.ok(s && s.end - s.start >= 20 && s.end - s.start <= 75 * 1.15, 'snap deve respeitar min/max');

// 2) legendas ASS
const ass = buildAss(words, 10, 40);
assert.match(ass, /Dialogue:/);
assert.match(ass, /\{\\k\d+\}/);

// 3) pipeline completo com vídeo
const out1 = path.join(tmp, 'out_video');
const r1 = await processMedia({ mediaPath: video, workdir: tmp, outDir: out1, count: 3, transcript });
assert.ok(r1.clips.length >= 2, `esperava >=2 clips, veio ${r1.clips.length}`);
for (const c of r1.clips) {
  const p = await probe(c.file);
  assert.equal(p.width, 1080);
  assert.equal(p.height, 1920);
  assert.ok(p.duration >= 15 && p.duration <= 90, `duração fora do esperado: ${p.duration}`);
  assert.ok(p.hasAudio, 'clip sem áudio');
  await fs.access(c.thumb);
}
console.log(`✓ vídeo: ${r1.clips.length} clips 1080x1920 (modos: ${r1.clips.map((c) => c.mode).join(', ')})`);

// 4) pipeline com áudio-only (podcast)
const out2 = path.join(tmp, 'out_audio');
const r2 = await processMedia({ mediaPath: audio, workdir: tmp, outDir: out2, count: 2, transcript });
assert.ok(r2.clips.length >= 1);
const pa = await probe(r2.clips[0].file);
assert.equal(pa.width, 1080);
assert.equal(pa.height, 1920);
console.log(`✓ áudio-only: ${r2.clips.length} clips renderizados com forma de onda`);

await fs.rm(tmp, { recursive: true, force: true });
console.log('Todos os testes passaram.');
