-- Clipa: schema inicial
-- Acesso é feito só pelo servidor (service role), então RLS fica ligado sem policies.

create extension if not exists pgcrypto;

do $$ begin
  create type job_status as enum ('queued', 'processing', 'done', 'failed');
exception when duplicate_object then null; end $$;

create table if not exists public.jobs (
  id            uuid primary key default gen_random_uuid(),
  source_type   text not null check (source_type in ('url', 'upload')),
  source_url    text,
  storage_path  text,
  title         text,
  status        job_status not null default 'queued',
  stage         text,
  progress      int not null default 0,
  error         text,
  duration_s    numeric,
  language      text,
  options       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz
);

create table if not exists public.clips (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.jobs(id) on delete cascade,
  rank        int not null,
  start_s     numeric not null,
  end_s       numeric not null,
  title       text,
  hook        text,
  score       int,
  reason      text,
  mode        text,
  status      text not null default 'pending', -- pending | rendering | ready | failed
  video_path  text,
  thumb_path  text,
  created_at  timestamptz not null default now()
);

create index if not exists jobs_status_created_idx on public.jobs (status, created_at);
create index if not exists clips_job_rank_idx on public.clips (job_id, rank);

alter table public.jobs  enable row level security;
alter table public.clips enable row level security;

-- Buckets privados (arquivos são servidos por URL assinada)
insert into storage.buckets (id, name, public)
values ('uploads', 'uploads', false), ('clips', 'clips', false)
on conflict (id) do nothing;

-- Pega o próximo job da fila (e reassume jobs travados há mais de 30 min).
create or replace function public.claim_job()
returns public.jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  j public.jobs;
begin
  update public.jobs
     set status = 'processing',
         started_at = coalesce(started_at, now()),
         updated_at = now(),
         error = null
   where id = (
     select id from public.jobs
      where status = 'queued'
         or (status = 'processing' and updated_at < now() - interval '30 minutes')
      order by created_at
      for update skip locked
      limit 1
   )
  returning * into j;

  if j.id is null then
    return null;
  end if;
  return j;
end;
$$;

revoke all on function public.claim_job() from public, anon, authenticated;
grant execute on function public.claim_job() to service_role;
