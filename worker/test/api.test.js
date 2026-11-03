// Testa as integrações externas com servidores/fetch falsos (sem chaves reais):
//  1) transcrição: envio do áudio em multipart + junção de pedaços com offset
//  2) rodízio de modelos do OpenRouter: 429 -> lixo -> JSON válido
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.TRANSCRIBE_API_KEY = 'test-key';
process.env.OPENROUTER_API_KEY = 'or-test';
process.env.OPENROUTER_MODELS = 'm/one:free,m/two:free,m/three:free';
delete process.env.ANTHROPIC_API_KEY;

// ---------- 1) transcrição ----------
let hits = 0;
let sawFile = false;
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    hits++;
    const body = Buffer.concat(chunks).toString('latin1');
    sawFile = /name="file"/.test(body) && /name="model"/.test(body) && /timestamp_granularities\[\]/.test(body);
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        language: 'portuguese',
        segments: [{ start: 0, end: 2, text: ' Olá mundo, isto é um teste.' }],
        words: [
          { word: 'Olá', start: 0, end: 0.5 },
          { word: 'mundo,', start: 0.5, end: 1 },
        ],
      }),
    );
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.TRANSCRIBE_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;

const { run } = await import('../src/ffmpeg.js');
const { transcribe } = await import('../src/transcribe.js');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'clipa-api-'));
const src = path.join(tmp, 'a.mp3');
await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=6', src]);
const t = await transcribe(src, tmp, { language: 'pt' });
assert.ok(hits >= 1 && sawFile, 'deveria enviar o áudio como multipart com model e timestamps');
assert.equal(t.segments.length, 1);
assert.equal(t.words[0].w, 'Olá');
console.log('✓ transcrição: áudio enviado em multipart e resposta lida');
server.close();

// ---------- 1b) limite 429 com retry-after + cache em disco ----------
const { retryDelayMs } = await import('../src/transcribe.js');
assert.equal(retryDelayMs({ headers: new Headers() }, 'Please try again in 5m7.5s.'), 307500);
assert.equal(retryDelayMs({ headers: new Headers({ 'retry-after': '3' }) }, ''), 3000);

let hits429 = 0;
const server2 = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    hits429++;
    res.setHeader('content-type', 'application/json');
    if (hits429 === 1) {
      res.statusCode = 429;
      res.setHeader('retry-after', '1');
      return res.end('{"error":{"message":"Rate limit reached"}}');
    }
    res.end(JSON.stringify({ language: 'pt', segments: [{ start: 0, end: 2, text: 'ok' }], words: [] }));
  });
});
await new Promise((r) => server2.listen(0, '127.0.0.1', r));
const { cfg } = await import('../src/config.js');
cfg.transcribe.baseUrl = `http://127.0.0.1:${server2.address().port}/v1`;
const cacheDir = path.join(tmp, 'cache');
const t0 = Date.now();
const t2 = await transcribe(src, tmp, { language: 'pt', cacheDir, log: () => {} });
assert.equal(hits429, 2, '429 deveria esperar e tentar de novo');
assert.ok(Date.now() - t0 >= 2500, 'deveria ter esperado o retry-after');
assert.equal(t2.segments[0].text, 'ok');
await transcribe(src, tmp, { language: 'pt', cacheDir, log: () => {} });
assert.equal(hits429, 2, 'segunda execução deveria usar o cache, sem chamar a API');
console.log('✓ transcrição: espera o limite (429) e reaproveita o cache');
server2.close();

// ---------- 2) rodízio OpenRouter ----------
const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('openrouter.ai/api/v1/chat/completions')) {
    const model = JSON.parse(opts.body).model;
    calls.push(model);
    if (model === 'm/one:free') return new Response('rate limited', { status: 429 });
    if (model === 'm/two:free') {
      return Response.json({ choices: [{ message: { content: 'desculpe, não consigo' } }] });
    }
    return Response.json({
      choices: [
        {
          message: {
            content:
              'Aqui vai:\n```json\n' +
              JSON.stringify([
                { first: 2, last: 8, title: 'Ótimo trecho', hook: 'Ninguém te conta', score: 91, reason: 'gancho forte' },
              ]) +
              '\n```',
          },
        },
      ],
    });
  }
  return realFetch(url, opts);
};

const { pickClips } = await import('../src/score.js');
const segments = [];
for (let i = 0; i < 20; i++) segments.push({ start: i * 5, end: i * 5 + 5, text: `Frase número ${i} sobre dinheiro e erro?` });
const clips = await pickClips({ segments }, 100, { count: 2 });
assert.deepEqual(calls.slice(0, 3), ['m/one:free', 'm/two:free', 'm/three:free'], 'deveria girar 429 -> lixo -> ok');
assert.ok(calls.length >= 4, 'deveria fazer a 2ª passada (revisão)');
assert.ok(clips.length >= 1);
assert.equal(clips[0].title, 'Ótimo trecho', 'o candidato do modelo deve vencer a heurística');
assert.ok(Math.abs(clips[0].start - 10) < 0.5 && Math.abs(clips[0].end - 45) < 0.5, 'início/fim vêm das frases #2 a #8');
console.log(`✓ OpenRouter: rodízio ${calls.join(' → ')} e escolha do trecho por frases`);

// ---------- 3) frases e revisão ----------
const { buildSentences, heuristicCandidates } = await import('../src/score.js');
const sents = buildSentences({
  segments: [
    { start: 0, end: 4, text: 'Primeiro ponto: o que é receita' },
    { start: 4, end: 8, text: 'eficiente? É simples. Então, aí' },
    { start: 8, end: 12, text: 'vem o resto.' },
  ],
  words: [],
});
assert.deepEqual(sents.map((x) => x.text), ['Primeiro ponto: o que é receita eficiente?', 'É simples.', 'Então, aí vem o resto.']);
assert.equal(sents[0].start, 0);
assert.ok(sents[0].end > 4 && sents[0].end < 8, 'frase que atravessa segmentos termina no meio do 2º');
const hc = heuristicCandidates(
  [
    { id: 0, start: 0, end: 20, text: 'Então isso aqui é importante.' },
    { id: 1, start: 20, end: 40, text: 'Qual é o maior erro de quem anuncia?' },
    { id: 2, start: 40, end: 60, text: 'Gastar sem medir nada.' },
  ],
  { min: 20, max: 75 },
);
assert.ok(hc.length && hc.every((c) => c.start !== 0), 'heurística não abre clipe com "Então isso…"');
console.log('✓ frases: junta segmentos quebrados; heurística evita começo dependente');

// revisão: ajusta o 1º rascunho e descarta o 2º
globalThis.fetch = async (url, opts) => {
  if (!String(url).includes('chat/completions')) return realFetch(url, opts);
  const prompt = JSON.parse(opts.body).messages[1].content;
  const answer = prompt.startsWith('Review these draft clips')
    ? [
        { draft: 1, first: 1, last: 9, keep: true, score: 88, title: 'Revisado', hook: 'h', reason: 'pensamento completo' },
        { draft: 2, first: 12, last: 18, keep: false, score: 10, title: 'x', hook: 'x', reason: 'depende de contexto' },
      ]
    : [
        { first: 2, last: 8, title: 'A', hook: 'a', score: 80, reason: 'r' },
        { first: 12, last: 18, title: 'B', hook: 'b', score: 70, reason: 'r' },
      ];
  return Response.json({ choices: [{ message: { content: JSON.stringify(answer) } }] });
};
const reviewed = await pickClips({ segments }, 100, { count: 3 });
assert.equal(reviewed.length, 1, 'o rascunho reprovado na revisão sai');
assert.equal(reviewed[0].title, 'Revisado');
assert.ok(Math.abs(reviewed[0].start - 5) < 0.5 && Math.abs(reviewed[0].end - 50) < 0.5, 'revisão ajusta início/fim');
console.log('✓ revisão: ajusta início/fim e descarta trecho sem sentido sozinho');

globalThis.fetch = realFetch;
await fs.rm(tmp, { recursive: true, force: true });
console.log('Testes de API passaram.');
