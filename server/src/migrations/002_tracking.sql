-- Automated daily rank tracking.
--
-- The load-bearing decision here is that **scans are shared, not per-user**. Ten
-- sellers tracking "logo design" is one scan, not ten: we store the full ordered
-- result set once, and every user's rank is a query against it.
--
-- That makes proxy bandwidth — the only real per-scan cost — grow with the number
-- of distinct keywords rather than the number of subscribers, and it means a new
-- subscriber inherits history for a keyword someone else was already tracking.
-- Retrofitting this later would mean rewriting every rank query, so it goes in now.

create table if not exists scan_runs (
  id            uuid primary key default gen_random_uuid(),
  keyword       text not null,
  country       text not null default 'default',
  sort_mode     text not null,
  status        text not null default 'pending',
  pages_scanned integer not null default 0,
  results_count integer not null default 0,
  error         text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz
);

-- The lookup behind "has this been scanned today?".
create index if not exists scan_runs_lookup_idx
  on scan_runs (keyword, country, sort_mode, started_at desc);

create table if not exists scan_results (
  run_id    uuid not null references scan_runs (id) on delete cascade,
  position  integer not null,
  username  text not null,
  slug      text not null,
  gig_id    text,
  title     text,
  primary key (run_id, position)
);

-- Finding one seller's rank in a stored run.
create index if not exists scan_results_username_idx on scan_results (username);

create table if not exists tracked_keywords (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  keyword     text not null,
  username    text not null,
  country     text not null default 'default',
  sort_modes  text[] not null default array['relevance'],
  active      boolean not null default true,
  next_run_at timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  unique (user_id, keyword, username, country)
);

-- The scheduler's hot path: which rows are due?
create index if not exists tracked_keywords_due_idx
  on tracked_keywords (next_run_at)
  where active;
