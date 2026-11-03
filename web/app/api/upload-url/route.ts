import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/supabase';

const partPath = (p: string, i: number) => `${p}.part${String(i).padStart(3, '0')}`;

// Gera URLs assinadas para o navegador enviar o arquivo direto ao Supabase Storage.
// Arquivos grandes vão em partes (o Supabase grátis aceita no máximo 50 MB por arquivo);
// o worker junta as partes depois.
export async function POST(req: Request) {
  try {
    const { filename, parts: rawParts } = await req.json();
    const parts = Math.min(200, Math.max(0, parseInt(rawParts, 10) || 0));
    if (typeof filename !== 'string' || !filename) {
      return NextResponse.json({ error: 'Nome de arquivo inválido.' }, { status: 400 });
    }
    const safe = filename.replace(/[^\w.\-]+/g, '_').slice(-80);
    const path = `${randomUUID()}_${safe}`;
    const store = db().storage.from('uploads');
    if (!parts) {
      const { data, error } = await store.createSignedUploadUrl(path);
      if (error) throw new Error(error.message);
      return NextResponse.json({ path, token: data.token });
    }
    const tokens = await Promise.all(
      Array.from({ length: parts }, async (_, i) => {
        const { data, error } = await store.createSignedUploadUrl(partPath(path, i));
        if (error) throw new Error(error.message);
        return data.token;
      }),
    );
    return NextResponse.json({ path, parts, tokens });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
