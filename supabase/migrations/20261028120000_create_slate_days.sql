-- Slate-day markers (#98).
--
-- A day with no games has no `games` row to carry an ingested_at, so a refresh
-- could not tell "upstream was asked and there was nothing" from "upstream has
-- never been asked": an empty day therefore cost one request per page view. The
-- slate page has to render an empty state without spending anything, so the
-- refresh records that it looked -- once per calendar day -- in this table.
--
-- It is bookkeeping, not the cache itself: no page renders from it. A missing
-- row only means the next refresh asks upstream again.

create table public.slate_days (
  -- The calendar date upstream was asked about, not the day of the request.
  game_date date primary key,
  -- How many games that answer held. Zero is the interesting value: it is what
  -- lets an off-season day be answered from the database.
  games integer not null check (games >= 0),
  checked_at timestamptz not null default now()
);

alter table public.slate_days enable row level security;

comment on table public.slate_days is
  'One row per calendar day upstream has been asked about, so an empty day is remembered instead of re-fetched on every page view.';
