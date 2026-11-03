import { NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { wakeWorker } from '@/lib/dispatch';

type Ctx = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f-]{36}$/i;

export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    if (!UUID.test(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 });
    const sb = db();

    const { data: job, error } = await sb.from('jobs').select('*').eq('id', id).single();
    if (error || !job) return NextResponse.json({ error: 'Job não encontrado' }, { status: 404 });

    const { data: clips } = await sb.from('clips').select('*').eq('job_id', id).order('rank');
    const out = await Promise.all(
      (clips ?? []).map(async (c) => {
        if (c.status !== 'ready' || !c.video_path) return c;
        const safeTitle = (c.title || `clip-${c.rank}`).replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || `clip-${c.rank}`;
        const [v, t, d] = await Promise.all([
          sb.storage.from('clips').createSignedUrl(c.video_path, 3600),
          sb.storage.from('clips').createSignedUrl(c.thumb_path, 3600),
          sb.storage.from('clips').createSignedUrl(c.video_path, 3600, { download: `${safeTitle}.mp4` }),
        ]);
        return {
          ...c,
          video_url: v.data?.signedUrl ?? null,
          thumb_url: t.data?.signedUrl ?? null,
          download_url: d.data?.signedUrl ?? null,
        };
      }),
    );
    return NextResponse.json({ job, clips: out });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

// Reenfileira um job (falhou, ou terminou e o usuário quer refazer os cortes),
// opcionalmente trocando legendas e quantidade de clipes.
export async function POST(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    if (!UUID.test(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 });
    const body = await req.json().catch(() => ({}));
    const sb = db();
    const { data: job, error: e1 } = await sb.from('jobs').select('status, options').eq('id', id).single();
    if (e1 || !job) return NextResponse.json({ error: 'Job não encontrado' }, { status: 404 });
    if (job.status !== 'done' && job.status !== 'failed') {
      return NextResponse.json({ error: 'Este projeto ainda está sendo processado.' }, { status: 409 });
    }
    const options = { ...(job.options || {}) };
    if (typeof body?.options?.captions === 'boolean') options.captions = body.options.captions;
    const n = parseInt(body?.options?.count, 10);
    if (n >= 1 && n <= 20) options.count = n;

    // apaga clipes antigos (linhas e arquivos), mas mantém a transcrição guardada
    await sb.from('clips').delete().eq('job_id', id);
    const { data: files } = await sb.storage.from('clips').list(id, { limit: 200 });
    const old = (files ?? []).filter((f) => f.name !== 'transcript.json').map((f) => `${id}/${f.name}`);
    if (old.length) await sb.storage.from('clips').remove(old);

    const { error } = await sb
      .from('jobs')
      .update({ status: 'queued', stage: null, progress: 0, error: null, finished_at: null, options, updated_at: new Date().toISOString() })
      .eq('id', id)
      .in('status', ['failed', 'done']);
    if (error) throw new Error(error.message);
    await wakeWorker();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    if (!UUID.test(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 });
    const sb = db();
    const { data: files } = await sb.storage.from('clips').list(id, { limit: 200 });
    if (files?.length) await sb.storage.from('clips').remove(files.map((f) => `${id}/${f.name}`));
    // apaga também o vídeo enviado (inteiro ou em partes)
    const { data: job } = await sb.from('jobs').select('storage_path, options').eq('id', id).single();
    if (job?.storage_path) {
      const n = parseInt(job.options?.parts, 10) || 0;
      const paths = n
        ? Array.from({ length: n }, (_, i) => `${job.storage_path}.part${String(i).padStart(3, '0')}`)
        : [job.storage_path];
      await sb.storage.from('uploads').remove(paths);
    }
    const { error } = await sb.from('jobs').delete().eq('id', id);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
