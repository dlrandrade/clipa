'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';
import { ago, fmtTime, STAGE_LABEL, type Job } from '@/lib/types';

const STATUS_LABEL: Record<string, string> = {
  queued: 'Na fila',
  processing: 'Processando',
  done: 'Pronto',
  failed: 'Falhou',
};

export default function Home() {
  const router = useRouter();
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [count, setCount] = useState(10);
  const [language, setLanguage] = useState('');
  const [captions, setCaptions] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/jobs', { cache: 'no-store' });
    if (res.status === 401) return router.replace('/login');
    const j = await res.json();
    if (res.ok) setJobs(j.jobs);
    else setError(j.error || 'Erro ao carregar.');
  }, [router]);

  useEffect(() => {
    load();
  }, [load]);

  const active = jobs?.some((j) => j.status === 'queued' || j.status === 'processing');
  useEffect(() => {
    const t = setInterval(load, active ? 3000 : 20000);
    return () => clearInterval(t);
  }, [load, active]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const options = { count, language: language || null, captions };
      let body: Record<string, unknown>;

      if (file) {
        const up = await fetch('/api/upload-url', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ filename: file.name }),
        });
        const u = await up.json();
        if (!up.ok) throw new Error(u.error || 'Falha ao preparar o envio.');
        const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
          auth: { persistSession: false },
        });
        const { error: upErr } = await sb.storage.from('uploads').uploadToSignedUrl(u.path, u.token, file);
        if (upErr) throw new Error(`Envio falhou: ${upErr.message}`);
        body = { storage_path: u.path, title: file.name, options };
      } else {
        if (!url.trim()) throw new Error('Cole um link ou escolha um arquivo.');
        body = { url: url.trim(), options };
      }

      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'Não foi possível criar o job.');
      router.push(`/jobs/${j.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  async function logout() {
    await fetch('/api/login', { method: 'DELETE' });
    router.replace('/login');
  }

  return (
    <div className="wrap">
      <header className="top">
        <div className="brand">
          <i /> Clipa
        </div>
        <button className="linkbtn" onClick={logout}>
          Sair
        </button>
      </header>

      <section className="hero">
        <p className="eyebrow">Vídeo longo → clipes verticais</p>
        <h1 className="display">
          Cole um link.
          <br />
          Receba os <em>melhores cortes.</em>
        </h1>
        <p className="lede">
          A Clipa transcreve, encontra os momentos com mais potencial, reenquadra em 9:16 e queima legendas palavra por palavra.
        </p>

        <form className="composer" onSubmit={submit}>
          <div className="row">
            <input
              className="url"
              placeholder={file ? file.name : 'https://youtube.com/watch?v=…'}
              value={file ? '' : url}
              disabled={!!file}
              onChange={(e) => setUrl(e.target.value)}
              inputMode="url"
            />
            <button className="btn" disabled={busy}>
              {busy ? 'Enviando…' : 'Gerar clipes'}
            </button>
          </div>
          <div className="opts">
            <span>
              ou{' '}
              <span className="filepick" onClick={() => fileRef.current?.click()}>
                {file ? 'trocar arquivo' : 'enviar um arquivo'}
              </span>
              {file && (
                <>
                  {' · '}
                  <span
                    className="filepick"
                    onClick={() => {
                      setFile(null);
                      if (fileRef.current) fileRef.current.value = '';
                    }}
                  >
                    remover
                  </span>
                </>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="video/*,audio/*"
                hidden
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </span>
            <label>
              Clipes
              <select value={count} onChange={(e) => setCount(+e.target.value)}>
                {[3, 5, 8, 10, 15].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Idioma
              <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                <option value="">Detectar</option>
                <option value="pt">Português</option>
                <option value="en">Inglês</option>
                <option value="es">Espanhol</option>
              </select>
            </label>
            <label>
              <input type="checkbox" checked={captions} onChange={(e) => setCaptions(e.target.checked)} />
              Legendas
            </label>
          </div>
          {error && <p className="err">{error}</p>}
        </form>
        <p className="hint">Use apenas conteúdo seu ou com permissão do dono. Você é responsável pelos direitos do material que corta e publica.</p>
      </section>

      <div className="sectionhead">
        <h2>Seus projetos</h2>
      </div>
      <div className="jobs">
        {jobs === null && <p className="empty">Carregando…</p>}
        {jobs?.length === 0 && <p className="empty">Nada por aqui ainda. Cole um link acima.</p>}
        {jobs?.map((j) => (
          <Link key={j.id} href={`/jobs/${j.id}`} className="job">
            {j.cover_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="cover" src={j.cover_url} alt="" />
            ) : (
              <div className="cover" />
            )}
            <div>
              <p className="jtitle">{j.title || j.source_url || 'Sem título'}</p>
              <div className="jmeta">
                <span>{ago(j.created_at)}</span>
                {j.duration_s ? <span>{fmtTime(j.duration_s)} de vídeo</span> : null}
                {j.status === 'done' && <span>{j.clips_ready} clipes</span>}
                {j.status === 'processing' && <span>{STAGE_LABEL[j.stage ?? ''] ?? '…'}</span>}
              </div>
              {(j.status === 'processing' || j.status === 'queued') && (
                <div className="bar">
                  <span style={{ width: `${Math.max(3, j.progress)}%` }} />
                </div>
              )}
            </div>
            <span className={`pill ${j.status}`}>{STATUS_LABEL[j.status]}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
