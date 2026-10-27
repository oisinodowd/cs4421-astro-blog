-- Close the Data API to everyone but the container (#93).
--
-- The site has no login, so there is no browser-to-database path at all: every
-- read and write goes through an SSR endpoint holding the service-role key, which
-- never leaves the ECS task. That leaves the Data API roles with nothing to
-- grant, and no policies to write -- row level security with no grant and no
-- policy denies everything, which is the whole of the intent.
--
-- These revokes are the control, not a tidy-up. A project created with the hosted
-- default (api.auto_expose_new_tables, and the local stack with the same setting
-- -- see config.toml) grants new tables, sequences and functions in public to
-- anon, authenticated and service_role as they are created. Without this, every
-- table above would be readable and writable by anyone holding the anon key,
-- which by definition is anybody who loads a page.

-- Note on what this does and does not cover: both roles keep USAGE on the
-- schema, because the project grants it to PUBLIC rather than to the roles
-- individually. That is left alone deliberately -- PUBLIC is where unrelated
-- tooling gets its access -- and it buys an attacker nothing, since the
-- object-level revokes below are what deny the request (the API answers
-- `permission denied for table sessions`, not a schema error).
revoke all on schema public from anon, authenticated;

-- The objects, named as well as in bulk, so this file still says what it covers
-- if it is read on its own.
revoke all on table public.teams from anon, authenticated;
revoke all on table public.games from anon, authenticated;
revoke all on table public.player_stats from anon, authenticated;
revoke all on table public.upstream_budget from anon, authenticated;
revoke all on table public.sessions from anon, authenticated;
revoke all on table public.session_drills from anon, authenticated;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;

-- PostgreSQL grants EXECUTE on a new function to PUBLIC, which would reach the
-- budget function regardless of the revokes above.
revoke all on function public.consume_upstream_budget(date, integer, integer)
  from public, anon, authenticated;

-- The container's role keeps what the application needs: it reads and writes
-- these tables and calls the budget function through the same Data API.
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant all on all functions in schema public to service_role;

-- And it stays that way for anything a later migration adds, rather than relying
-- on every author remembering to repeat the revokes.
alter default privileges in schema public
  revoke all on tables from anon, authenticated;
alter default privileges in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges in schema public
  revoke all on functions from anon, authenticated;
