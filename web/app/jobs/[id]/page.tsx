'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { fmtTime, STAGE_LABEL, type Clip, type Job } from '@/lib/types';

export default function JobPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [job, setJob] = useState<Job | null>(null);
  const [clips, setClips] = useState<Clip[]>([]);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/jobs/${id}`, { cache: 'no-store' });
    if (res.status === 401) return router.replace('/login');
    const j = await res.json();
    if (!res.ok) return setError(j.error || 'Erro ao carregar.');
    setJob(j.job);
    setClips(j.clips);
  }, [id, router]);

  useEffect(() => {
    load();
  }, [load]);

  const running = job?.status === 'queued' || job?.status === 'processing';
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [running, load]);

  const [redoCaptions, setRedoCaptions] = useState<boolean | null>(null);
  const [redoCount, setRedoCount] = useState<number | null>(null);
  const [redoing, setRedoing] = useState(false);

  async function retry() {
    if (redoing) return;
    setRedoing(true);
    const options: Record<string, unknown> = {};
    if (redoCaptions !== null) options.captions = redoCaptions;
    if (redoCount !== null) options.count = redoCount;
    const res = await fetch(`/api/jobs/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ options }),
    });
    if (!res.ok) setError((await res.json().catch(() => ({}))).error || 'Não foi possível refazer.');
    setRedoing(false);
    load();
  }

  async function remove() {
    if (!confirm('Apagar este projeto e todos os clipes?')) return;
    await fetch(`/api/jobs/${id}`, { method: 'DELETE' });
    router.replace('/');
  }

  async function copy(text: string, key: string) {
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  }

  if (error) {
    return (
      <div className="wrap">
        <Link href="/" className="back">← Voltar</Link>
        <p className="err">{error}</p>
      </div>
    );
  }
  if (!job) return <div className="wrap"><p className="empty">Carregando…</p></div>;

  const stage = job.status === 'queued' ? 'Aguardando o worker pegar este projeto' : STAGE_LABEL[job.stage ?? ''] ?? 'Processando';

  return (
    <div className="wrap">
      <Link href="/" className="back">← Projetos</Link>

      <div className="jobhead">
        <h1>{job.title || job.source_url || 'Processando…'}</h1>
        <div className="status">
          <span className={`pill ${job.status}`}>
            {job.status === 'done' ? 'Pronto' : job.status === 'failed' ? 'Falhou' : running ? stage : ''}
          </span>
          {job.duration_s ? <span>{fmtTime(job.duration_s)} de vídeo</span> : null}
          {job.language ? <span>idioma: {job.language}</span> : null}
          {job.options ? <span>{job.options.captions === false ? 'sem legendas' : 'com legendas'}</span> : null}
          <button className="linkbtn" onClick={remove}>Apagar</button>
        </div>
        {running && (
          <div className="bar" style={{ maxWidth: 420 }}>
            <span style={{ width: `${Math.max(3, job.progress)}%` }} />
          </div>
        )}
      </div>

      {job.status === 'failed' && (
        <div className="panel error">
          <p style={{ margin: '0 0 12px' }}>{job.error || 'Algo deu errado.'}</p>
        </div>
      )}

      {(job.status === 'done' || job.status === 'failed') && (
        <div className="panel redopanel">
          <p>
            {job.status === 'failed'
              ? 'Ajuste se quiser e tente de novo.'
              : clips.some((c) => c.status === 'failed')
                ? `${clips.filter((c) => c.status === 'failed').length} clipe(s) falharam. Refaça para tentar de novo.`
                : 'Não gostou? Refaça os cortes. A transcrição fica guardada, então é mais rápido.'}
          </p>
          <label>
            Legendas
            <select
              value={(redoCaptions ?? job.options?.captions !== false) ? 'on' : 'off'}
              onChange={(e) => setRedoCaptions(e.target.value === 'on')}
            >
              <option value="on">Com legendas</option>
              <option value="off">Sem legendas</option>
            </select>
          </label>
          <label>
            Clipes
            <select value={redoCount ?? job.options?.count ?? 10} onChange={(e) => setRedoCount(+e.target.value)}>
              {[3, 5, 8, 10, 15].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
          <button className="btn ghost" onClick={retry} disabled={redoing}>
            {redoing ? 'Enviando…' : job.status === 'failed' ? 'Tentar de novo' : 'Refazer cortes'}
          </button>
        </div>
      )}

      {job.status === 'queued' && (
        <div className="panel">
          <p style={{ margin: 0, color: 'var(--muted)' }}>
            O worker (o programa que processa o vídeo) precisa estar ligado. Se nada acontecer em alguns segundos, confira se ele está rodando.
          </p>
        </div>
      )}

      <div className="grid">
        {clips.map((c) => (
          <div className="card" key={c.id}>
            <div className="frame">
              {c.status === 'ready' && c.video_url ? (
                <video src={c.video_url} poster={c.thumb_url ?? undefined} controls playsInline preload="none" />
              ) : (
                <div className="skeleton">{c.status === 'failed' ? 'Falhou' : c.status === 'rendering' ? 'Renderizando…' : 'Na fila…'}</div>
              )}
              {c.score != null && (
                <div className={`score ${c.score >= 80 ? 'hi' : ''}`}>
                  {c.score} <small>VIRAL</small>
                </div>
              )}
              <div className="rank">#{c.rank}</div>
            </div>
            <p className="ctitle">{c.title}</p>
            {c.hook && <p className="chook">“{c.hook}”</p>}
            <div className="cmeta">
              <span>{fmtTime(c.start_s)} → {fmtTime(c.end_s)}</span>
              <span>{Math.round(c.end_s - c.start_s)}s</span>
              {c.mode && <span>{c.mode === 'fill' ? 'recorte no rosto' : c.mode === 'audio' ? 'áudio' : 'quadro inteiro'}</span>}
            </div>
            {c.status === 'ready' && (
              <div className="actions">
                {c.download_url && (
                  <a className="btn small" href={c.download_url}>Baixar</a>
                )}
                <button className="btn ghost small" onClick={() => copy(c.title || '', `t${c.id}`)}>
                  {copied === `t${c.id}` ? 'Copiado ✓' : 'Copiar título'}
                </button>
              </div>
            )}
            {c.reason && (
              <details className="why">
                <summary>Por que este trecho</summary>
                <p>{c.reason}</p>
              </details>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
