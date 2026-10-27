-- Tracker cache (#93).
--
-- The tracker never calls upstream from a request path: the ingest in #97 fills
-- these tables and the pages in #98/#99 read only from here. Both ECS tasks share
-- this one database, which is also why the upstream request budget lives here
-- rather than in process memory.
--
-- Row level security is enabled in the same file that creates each table, so no
-- table exists in an unprotected state at any point during the migration.

create table public.teams (
  id integer primary key, -- balldontlie team id: the upstream identity is the key
  abbreviation text not null,
  city text not null,
  name text not null,
  full_name text not null,
  conference text,
  division text,
  updated_at timestamptz not null default now()
);

alter table public.teams enable row level security;

comment on table public.teams is
  'Team metadata captured as a side effect of slate ingestion, so the slate page renders names without a second upstream call.';

create table public.games (
  id integer primary key,
  game_date date not null,
  -- Upstream text ("Final", "2nd Qtr", "9:30 pm ET"). Whether a game is in a
  -- live window is decided by the ingest (#97), not by parsing this in the UI.
  status text not null,
  period integer, -- 1-4, 5+ in overtime
  clock text, -- time remaining in the period, as upstream formats it
  postseason boolean not null default false,
  home_team_id integer references public.teams (id),
  visitor_team_id integer references public.teams (id),
  home_score integer,
  visitor_score integer,
  home_q1 integer,
  home_q2 integer,
  home_q3 integer,
  home_q4 integer,
  visitor_q1 integer,
  visitor_q2 integer,
  visitor_q3 integer,
  visitor_q4 integer,
  -- These two have changed shape between seasons upstream. Kept as JSON rather
  -- than guessed into columns that would need a migration the next time.
  in_bonus jsonb,
  timeouts_remaining jsonb,
  -- The upstream object as received: a debugging aid for a shape change, not a
  -- source the UI renders from. One row per game, so the size is not a concern.
  raw jsonb,
  ingested_at timestamptz not null default now()
);

alter table public.games enable row level security;

create index games_game_date_idx on public.games (game_date desc);

create table public.player_stats (
  -- Composite key: a box score is always read one game at a time, and this makes
  -- the ingest upsert idempotent when a live game is re-fetched.
  game_id integer not null references public.games (id) on delete cascade,
  player_id integer not null,
  -- Denormalised on purpose: a box score query needs no player row that this
  -- game's own payload did not already contain.
  player_name text not null,
  team_id integer references public.teams (id),
  min text, -- upstream sends minutes as a string, e.g. "34:12"
  pts integer,
  reb integer,
  ast integer,
  stl integer,
  blk integer,
  turnover integer,
  pf integer,
  fgm integer,
  fga integer,
  fg3m integer,
  fg3a integer,
  ftm integer,
  fta integer,
  oreb integer,
  dreb integer,
  ingested_at timestamptz not null default now(),
  primary key (game_id, player_id)
);

alter table public.player_stats enable row level security;

-- No separate index on game_id: the primary key's leading column already serves
-- the box score lookup and the cascade.

create table public.upstream_budget (
  day date primary key, -- UTC day, matching the upstream quota window
  requests_used integer not null default 0 check (requests_used >= 0),
  daily_limit integer not null check (daily_limit > 0),
  updated_at timestamptz not null default now()
);

alter table public.upstream_budget enable row level security;

comment on table public.upstream_budget is
  'Shared upstream request accounting. It lives in Postgres because the service runs two ECS tasks: an in-process counter would be two counters, each believing it held the full daily allowance.';

-- Consume budget atomically, because either task can call this in the same
-- instant. A read-then-write in the application would race and let the pair spend
-- twice the intended allowance.
--
-- Returns one row: whether the request was allowed, and the state afterwards. A
-- rejected call consumes nothing.
create function public.consume_upstream_budget(
  p_day date,
  p_limit integer,
  p_cost integer default 1
)
returns table (allowed boolean, requests_used integer, daily_limit integer)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_used integer;
  v_limit integer;
begin
  if p_cost is null or p_cost < 1 then
    raise exception 'p_cost must be at least 1, got %', p_cost;
  end if;

  insert into public.upstream_budget as b (day, daily_limit, requests_used)
  values (p_day, p_limit, p_cost)
  on conflict (day) do update
    set requests_used = b.requests_used + p_cost,
        daily_limit = excluded.daily_limit,
        updated_at = now()
    where b.requests_used + p_cost <= b.daily_limit
  returning b.requests_used, b.daily_limit into v_used, v_limit;

  if not found then
    -- No headroom left: report the day's row unchanged.
    select b.requests_used, b.daily_limit into v_used, v_limit
    from public.upstream_budget b
    where b.day = p_day;

    return query select false, v_used, v_limit;
    return;
  end if;

  return query select true, v_used, v_limit;
end;
$$;
