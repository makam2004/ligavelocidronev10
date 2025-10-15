create extension if not exists pgcrypto;

-- Pilots
create table if not exists public.pilots (
  id uuid primary key default gen_random_uuid(),
  user_id integer not null unique,
  name text not null,
  country text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Tracks
create table if not exists public.tracks (
  id uuid primary key default gen_random_uuid(),
  title text,
  scenery_id integer not null,
  track_id integer not null,
  laps integer not null check (laps in (1,3)),
  active boolean not null default false,
  updated_at timestamptz not null default now()
);
create index if not exists idx_tracks_active on public.tracks(active);

-- Results (best known time per pilot/track/laps)
create table if not exists public.results (
  id uuid primary key default gen_random_uuid(),
  track_id integer not null,
  laps integer not null check (laps in (1,3)),
  user_id integer not null,
  playername text,
  best_time_ms integer not null,
  updated_at timestamptz not null default now(),
  unique(track_id, laps, user_id)
);
create index if not exists idx_results_track on public.results(track_id, laps);

-- RLS
alter table public.pilots enable row level security;
alter table public.tracks enable row level security;
alter table public.results enable row level security;

create policy "public read pilots" on public.pilots for select using (true);
create policy "public read tracks" on public.tracks for select using (true);
create policy "public read results" on public.results for select using (true);
