import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg } from './config.js';
import { run } from './ffmpeg.js';
import { buildAss } from './captions.js';

const here = path.dirname(fileURLToPath(import.meta.url));

async function decideFraming(video, start, end) {
  try {
    const { stdout } = await run(cfg.python, [path.join(here, 'reframe.py'), video, String(start), String(end)]);
    return JSON.parse(stdout.trim().split('\n').pop());
  } catch (e) {
    return { mode: 'blur', reason: 'probe-failed' };
  }
}

function buildFilter({ framing, info, sub }) {
  if (framing.mode === 'fill') {
    return (
      `[0:v]crop=${framing.cropW}:${info.height}:${framing.cropX}:0,` +
      `scale=1080:1920:flags=lanczos,setsar=1,fps=30${sub}[v]`
    );
  }
  // blur: quadro inteiro, centralizado, sobre fundo desfocado
  return (
    `[0:v]split=2[a][b];` +
    `[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=40:6,eq=brightness=-0.1[bg];` +
    `[b]scale=1080:-2:force_original_aspect_ratio=decrease:flags=lanczos[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=30${sub}[v]`
  );
}

/**
 * Corta [start,end] do arquivo, reenquadra para 9:16, queima legendas e gera thumbnail.
 * Retorna { file, thumb, mode }
 */
export async function renderClip({ video, info, start, end, words, outDir, name, captions = true }) {
  await fs.mkdir(outDir, { recursive: true });
  const dur = +(end - start).toFixed(3);
  const assName = `${name}.ass`;
  await fs.writeFile(path.join(outDir, assName), buildAss(words, start, end));
  const sub = captions ? `,ass=filename=${assName}` : '';
  const outFile = `${name}.mp4`;

  const enc = [
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    '-movflags', '+faststart',
    '-t', String(dur),
  ];

  let mode;
  let args;
  if (!info.hasVideo) {
    // Só áudio (podcast): fundo escuro + forma de onda
    mode = 'audio';
    args = [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'color=c=0x0b0b0c:s=1080x1920:r=30',
      '-ss', String(start), '-t', String(dur), '-i', video,
      '-filter_complex',
      `[1:a]showwaves=s=1080x420:mode=cline:colors=0xFFE000:rate=30[w];[0:v][w]overlay=0:760,setsar=1${sub}[v]`,
      '-map', '[v]', '-map', '1:a', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
      ...enc, outFile,
    ];
  } else {
    const framing = await decideFraming(video, start, end);
    mode = framing.mode;
    args = [
      '-y', '-v', 'error',
      '-ss', String(start), '-t', String(dur), '-i', video,
      '-filter_complex', buildFilter({ framing, info, sub }),
      '-map', '[v]', ...(info.hasAudio ? ['-map', '0:a', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11'] : []),
      ...enc, outFile,
    ];
  }

  // cwd = outDir para o filtro "ass" achar o arquivo sem problemas de escape de caminho
  await run('ffmpeg', args, { cwd: outDir });

  const thumbName = `${name}.jpg`;
  await run(
    'ffmpeg',
    ['-y', '-v', 'error', '-ss', String(Math.min(1.5, dur / 2)), '-i', outFile, '-frames:v', '1', '-vf', 'scale=360:-2', thumbName],
    { cwd: outDir },
  );

  return { file: path.join(outDir, outFile), thumb: path.join(outDir, thumbName), mode };
}
