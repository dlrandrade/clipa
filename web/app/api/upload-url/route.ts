import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/supabase';

// Gera uma URL assinada para o navegador enviar o arquivo direto ao Supabase Storage.
export async function POST(req: Request) {
  try {
    const { filename } = await req.json();
    if (typeof filename !== 'string' || !filename) {
      return NextResponse.json({ error: 'Nome de arquivo inválido.' }, { status: 400 });
    }
    const safe = filename.replace(/[^\w.\-]+/g, '_').slice(-80);
    const path = `${randomUUID()}_${safe}`;
    const { data, error } = await db().storage.from('uploads').createSignedUploadUrl(path);
    if (error) throw new Error(error.message);
    return NextResponse.json({ path, token: data.token });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
