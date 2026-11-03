import { NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { wakeWorker } from '@/lib/dispatch';

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[?::1\]?)$/i;

function cleanUrl(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('Cole um link válido.');
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error('Cole um link válido (começando com https://).');
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Só links http(s) são aceitos.');
  if (PRIVATE_HOST.test(u.hostname)) throw new Error('Esse endereço não é permitido.');
  return u.toString();
}

function cleanOptions(o: any) {
  const count = Math.min(20, Math.max(1, parseInt(o?.count, 10) || 10));
  const language = typeof o?.language === 'string' && /^[a-z]{2,3}$/i.test(o.language) ? o.language.toLowerCase() : null;
  return { count, language, captions: o?.captions !== false };
}

export async function GET() {
  try {
    const sb = db();
    const { data: jobs, error } = await sb
      .from('jobs')
      .select('id,source_type,source_url,title,status,stage,progress,error,duration_s,language,created_at')
      .order('created_at', { ascending: false })
      .limit(30);
    if (error) throw new Error(error.message);
    if (!jobs?.length) return NextResponse.json({ jobs: [] });

    const { data: clips } = await sb
      .from('clips')
      .select('job_id,rank,status,thumb_path')
      .in('job_id', jobs.map((j) => j.id));

    const out = await Promise.all(
      jobs.map(async (j) => {
        const mine = (clips ?? []).filter((c) => c.job_id === j.id);
        const cover = mine.filter((c) => c.status === 'ready' && c.thumb_path).sort((a, b) => a.rank - b.rank)[0];
        let cover_url: string | null = null;
        if (cover) {
          const s = await sb.storage.from('clips').createSignedUrl(cover.thumb_path, 3600);
          cover_url = s.data?.signedUrl ?? null;
        }
        return {
          ...j,
          clips_total: mine.length,
          clips_ready: mine.filter((c) => c.status === 'ready').length,
          cover_url,
        };
      }),
    );
    return NextResponse.json({ jobs: out });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const options = cleanOptions(body.options);
    let row: Record<string, unknown>;

    if (body.storage_path) {
      const p = String(body.storage_path);
      if (!/^[0-9a-f-]{36}_[\w.\-]+$/i.test(p)) throw new Error('Caminho de upload inválido.');
      row = {
        source_type: 'upload',
        storage_path: p,
        title: typeof body.title === 'string' ? body.title.slice(0, 200) : null,
        options: { ...options, parts: Math.min(200, Math.max(0, parseInt(body.parts, 10) || 0)) },
      };
    } else {
      const url = cleanUrl(body.url);
      row = { source_type: 'url', source_url: url, options };
    }

    const { data, error } = await db().from('jobs').insert(row).select('id').single();
    if (error) throw new Error(error.message);
    await wakeWorker();
    return NextResponse.json({ id: data.id }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
