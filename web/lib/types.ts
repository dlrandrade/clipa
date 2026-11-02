export type JobStatus = 'queued' | 'processing' | 'done' | 'failed';

export type Job = {
  id: string;
  source_type: 'url' | 'upload';
  source_url: string | null;
  title: string | null;
  status: JobStatus;
  stage: string | null;
  progress: number;
  error: string | null;
  duration_s: number | null;
  language: string | null;
  created_at: string;
  clips_total?: number;
  clips_ready?: number;
  cover_url?: string | null;
};

export type Clip = {
  id: string;
  rank: number;
  start_s: number;
  end_s: number;
  title: string | null;
  hook: string | null;
  score: number | null;
  reason: string | null;
  mode: string | null;
  status: 'pending' | 'rendering' | 'ready' | 'failed';
  video_url?: string | null;
  thumb_url?: string | null;
  download_url?: string | null;
};

export const STAGE_LABEL: Record<string, string> = {
  download: 'Baixando o vídeo',
  transcribe: 'Transcrevendo',
  pick: 'Escolhendo os melhores momentos',
  render: 'Renderizando os clipes',
  done: 'Pronto',
};

export function fmtTime(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '–';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`;
}

export function ago(iso: string): string {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return 'agora';
  if (d < 3600) return `há ${Math.floor(d / 60)} min`;
  if (d < 86400) return `há ${Math.floor(d / 3600)} h`;
  return `há ${Math.floor(d / 86400)} d`;
}
