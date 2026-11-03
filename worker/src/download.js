import fs from 'node:fs/promises';
import path from 'node:path';
import { cfg } from './config.js';
import { run } from './ffmpeg.js';

/** Baixa um link (YouTube, podcast, live gravada, URL direta de arquivo) com yt-dlp. */
export async function downloadUrl(url, dir) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Só links http(s) são aceitos.');

  const titleFile = path.join(dir, 'title.txt');
  const args = [
    '--no-playlist',
    '--no-warnings',
    '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b',
    '--merge-output-format', 'mp4',
    '-o', path.join(dir, 'source.%(ext)s'),
    '--print-to-file', '%(title)s', titleFile,
  ];
  if (cfg.ytdlp.cookiesFromBrowser) args.push('--cookies-from-browser', cfg.ytdlp.cookiesFromBrowser);
  if (cfg.ytdlp.cookiesFile) args.push('--cookies', cfg.ytdlp.cookiesFile);
  args.push(url);

  try {
    await run(cfg.ytdlp.bin, args);
  } catch (e) {
    const msg = String(e.message);
    if (/Programa não encontrado/.test(msg)) {
      throw new Error('yt-dlp não está instalado no worker. Instale com: pip install -U yt-dlp');
    }
    if (/Sign in to confirm|not a bot|HTTP Error 403|Video unavailable/i.test(msg)) {
      throw new Error(
        (process.env.GITHUB_ACTIONS
          ? 'O YouTube bloqueou o download no servidor. Cadastre o segredo YTDLP_COOKIES no GitHub (conteúdo do cookies.txt) ou rode o worker no seu computador. Detalhe: '
          : 'O site bloqueou o download deste link. Rode o worker no seu computador (IP residencial) ou defina YTDLP_COOKIES_FROM_BROWSER=chrome. Detalhe: ') +
          msg.slice(-300),
      );
    }
    throw e;
  }

  const files = (await fs.readdir(dir)).filter((f) => f.startsWith('source.') && !/\.(part|ytdl)$/.test(f));
  if (!files.length) throw new Error('O download terminou sem gerar arquivo.');
  const title = await fs.readFile(titleFile, 'utf8').then((t) => t.trim()).catch(() => '');
  return { file: path.join(dir, files[0]), title };
}
