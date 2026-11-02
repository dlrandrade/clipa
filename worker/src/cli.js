// Uso local, sem banco: node src/cli.js <arquivo-ou-link> [--out pasta] [--count 10] [--transcript t.json] [--language pt]
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { processMedia } from './pipeline.js';
import { downloadUrl } from './download.js';

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('--'));
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (!input) {
  console.error('Uso: node src/cli.js <arquivo-ou-link> [--out pasta] [--count 10] [--transcript t.json] [--language pt]');
  process.exit(1);
}

const outDir = path.resolve(flag('out') || './out');
const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'clipa-cli-'));
try {
  let mediaPath = input;
  if (/^https?:\/\//.test(input)) {
    console.log('Baixando…');
    mediaPath = (await downloadUrl(input, workdir)).file;
  }
  const transcript = flag('transcript') ? JSON.parse(await fs.readFile(flag('transcript'), 'utf8')) : undefined;

  const { clips } = await processMedia({
    mediaPath,
    workdir,
    outDir,
    count: flag('count') ? parseInt(flag('count'), 10) : undefined,
    language: flag('language'),
    transcript,
    hooks: {
      onStage: (s, p) => p === 0 && console.log(`→ ${s}`),
      onPicks: (p) => console.log(`→ ${p.length} momentos escolhidos`),
      onClipDone: (c, r) => console.log(`  ✓ #${c.rank} [${c.score}] ${c.title} (${r.mode})`),
      onClipFailed: (c, e) => console.error(`  ✗ #${c.rank}: ${e.message}`),
    },
  });
  await fs.writeFile(
    path.join(outDir, 'clips.json'),
    JSON.stringify(clips.map(({ file, thumb, ...c }) => ({ ...c, file: path.basename(file) })), null, 2),
  );
  console.log(`\nPronto! ${clips.length} clips em ${outDir}`);
} finally {
  await fs.rm(workdir, { recursive: true, force: true });
}
