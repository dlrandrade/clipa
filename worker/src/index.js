import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { cfg } from './config.js';
import { processMedia } from './pipeline.js';
import { downloadUrl } from './download.js';

if (!cfg.supabase.url || !cfg.supabase.serviceKey) {
  console.error('Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no arquivo .env do worker.');
  process.exit(1);
}
const sb = createClient(cfg.supabase.url, cfg.supabase.serviceKey, { auth: { persistSession: false } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const unwrap = ({ data, error }) => {
  if (error) throw new Error(error.message);
  return data;
};

async function upload(bucket, storagePath, file, contentType) {
  const body = await fs.readFile(file);
  unwrap(await sb.storage.from(bucket).upload(storagePath, body, { contentType, upsert: true }));
}

async function handle(job) {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'clipa-'));
  const dlDir = path.join(workdir, 'dl');
  const outDir = path.join(workdir, 'out');
  const cacheDir = path.join(os.homedir(), '.clipa-cache', job.id);
  await fs.mkdir(dlDir);
  const patch = (p) =>
    sb.from('jobs').update({ ...p, updated_at: new Date().toISOString() }).eq('id', job.id).then(unwrap);

  console.log(`[job ${job.id}] começando (${job.source_type})`);
  try {
    await patch({ stage: 'download', progress: 2 });

    let mediaPath;
    let title = job.title;
    if (job.source_type === 'url') {
      const r = await downloadUrl(job.source_url, dlDir);
      mediaPath = r.file;
      title = r.title || title;
    } else {
      const { data, error } = await sb.storage.from('uploads').download(job.storage_path);
      if (error) throw new Error(`Não consegui ler o upload: ${error.message}`);
      mediaPath = path.join(dlDir, path.basename(job.storage_path));
      await fs.writeFile(mediaPath, Buffer.from(await data.arrayBuffer()));
      title = title || path.basename(job.storage_path).replace(/^[0-9a-f-]{36}_/, '');
    }
    await patch({ title, stage: 'transcribe', progress: 10 });

    const opts = job.options || {};
    const clipRows = new Map(); // rank -> clip id
    const span = { transcribe: [10, 45], pick: [45, 55] };
    const stagePatch = (stage, p) => {
      const [a, b] = span[stage] || [0, 0];
      return patch({ stage, progress: Math.round(a + (b - a) * p) });
    };

    await processMedia({
      mediaPath,
      workdir,
      outDir,
      count: opts.count || cfg.clipCount,
      language: opts.language || undefined,
      captions: opts.captions !== false,
      cacheDir, // transcrição guardada: repetir o job não gasta a cota da API de novo
      hooks: {
        onInfo: (info) => patch({ duration_s: info.duration }),
        onStage: (stage, p) => (p === 0 || p === 1 ? stagePatch(stage, p) : undefined),
        onTranscript: (t) => patch({ language: t.language }),
        onPicks: async (picks) => {
          const rows = picks.map((c) => ({
            job_id: job.id,
            rank: c.rank,
            start_s: c.start,
            end_s: c.end,
            title: c.title,
            hook: c.hook,
            score: c.score,
            reason: c.reason,
            status: 'pending',
          }));
          const data = unwrap(await sb.from('clips').insert(rows).select('id, rank'));
          for (const r of data) clipRows.set(r.rank, r.id);
          await patch({ stage: 'render', progress: 55 });
        },
        onClipStart: async (c) => {
          unwrap(await sb.from('clips').update({ status: 'rendering' }).eq('id', clipRows.get(c.rank)));
        },
        onClipDone: async (c, r, i, n) => {
          const base = `${job.id}/clip_${String(c.rank).padStart(2, '0')}`;
          await upload('clips', `${base}.mp4`, r.file, 'video/mp4');
          await upload('clips', `${base}.jpg`, r.thumb, 'image/jpeg');
          unwrap(
            await sb
              .from('clips')
              .update({ status: 'ready', mode: r.mode, video_path: `${base}.mp4`, thumb_path: `${base}.jpg` })
              .eq('id', clipRows.get(c.rank)),
          );
          await patch({ progress: 55 + Math.round(((i + 1) / n) * 44) });
        },
        onClipFailed: async (c, e) => {
          console.error(`[job ${job.id}] clip #${c.rank} falhou:`, e.message);
          // sem coluna de erro no banco: o motivo vai no campo "reason", que aparece em "Por que este trecho"
          const why = `FALHOU — ${String(e.message).replace(/\s+/g, ' ').slice(-380)}`;
          unwrap(await sb.from('clips').update({ status: 'failed', reason: why }).eq('id', clipRows.get(c.rank)));
        },
      },
    });

    await patch({ status: 'done', stage: 'done', progress: 100, finished_at: new Date().toISOString() });
    await fs.rm(cacheDir, { recursive: true, force: true });
    if (job.source_type === 'upload') await sb.storage.from('uploads').remove([job.storage_path]);
    console.log(`[job ${job.id}] concluído`);
  } catch (e) {
    console.error(`[job ${job.id}] falhou:`, e.message);
    await patch({ status: 'failed', error: String(e.message).slice(0, 800), finished_at: new Date().toISOString() }).catch(() => {});
  } finally {
    await fs.rm(workdir, { recursive: true, force: true });
  }
}

console.log('Clipa worker ligado. Esperando jobs…');
for (;;) {
  try {
    const job = unwrap(await sb.rpc('claim_job'));
    if (job && job.id) await handle(job);
    else await sleep(cfg.pollMs);
  } catch (e) {
    console.error('Erro no loop:', e.message);
    await sleep(cfg.pollMs * 2);
  }
}
