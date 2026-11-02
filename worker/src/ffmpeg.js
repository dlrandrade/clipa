import { spawn } from 'node:child_process';

export function run(cmd, args, { cwd, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => {
      out += d;
    });
    p.stderr.on('data', (d) => {
      err += d;
      if (err.length > 20000) err = err.slice(-20000);
      onStderr?.(d.toString());
    });
    p.on('error', (e) =>
      reject(e.code === 'ENOENT' ? new Error(`Programa não encontrado: ${cmd}. Instale-o e tente de novo.`) : e),
    );
    p.on('close', (code) =>
      code === 0
        ? resolve({ stdout: out, stderr: err })
        : reject(new Error(`${cmd} saiu com código ${code}: ${err.slice(-1500)}`)),
    );
  });
}

export async function probe(file) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    file,
  ]);
  const j = JSON.parse(stdout);
  const v = j.streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const a = j.streams.find((s) => s.codec_type === 'audio');
  return {
    duration: parseFloat(j.format.duration),
    width: v?.width,
    height: v?.height,
    hasVideo: !!v,
    hasAudio: !!a,
  };
}
