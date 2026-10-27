-- Trainer storage (#93).
--
-- There are no accounts: the trainer identifies whoever is logging by a name held
-- in a cookie, so `sessions.trainee` is the grouping key. Anyone who can reach the
-- write endpoint can add a session, which is why #103 validates server side --
-- these constraints are the backstop behind that validation, not a replacement
-- for it.

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  trainee text not null check (length(btrim(trainee)) between 1 and 40),
  session_date date not null default current_date,
  duration_min integer not null check (duration_min between 1 and 600),
  feel text not null check (feel in ('rough', 'ok', 'good', 'great')),
  notes text check (length(notes) <= 2000),
  created_at timestamptz not null default now()
);

alter table public.sessions enable row level security;

-- The progress views (#104) read one trainee's sessions, most recent first.
create index sessions_trainee_date_idx
  on public.sessions (trainee, session_date desc, created_at desc);

create table public.session_drills (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.sessions (id) on delete cascade,
  -- Matches a file in src/content/drills/ (#102). A slug rather than a foreign
  -- key because the catalogue is content in the repository, not a table.
  drill_slug text not null check (drill_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  sets integer check (sets between 0 and 100),
  reps integer check (reps between 0 and 10000),
  makes integer check (makes between 0 and 10000),
  attempts integer check (attempts between 0 and 10000),
  weight_kg numeric(5, 2) check (weight_kg between 0 and 500),
  created_at timestamptz not null default now(),
  -- A shooting drill cannot have more makes than attempts. NULL is allowed,
  -- because a drill may record reps only (conditioning, for instance).
  constraint session_drills_makes_within_attempts
    check (makes is null or attempts is null or makes <= attempts)
);

alter table public.session_drills enable row level security;

create index session_drills_session_id_idx on public.session_drills (session_id);
