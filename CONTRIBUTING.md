# Development workflow

## Branches

- feat/* — new functionality (e.g. feat/ssr-adapter)
- fix/* — bug fixes
- ci/* — pipeline/tooling changes
- infra/* — CDK / AWS changes
- chore/* — maintenance

## Rules

- `main` is protected: all work lands via PR, required check = `validate`.
- Never force-push shared branches; history must be auditable.
- Commits use conventional style: `feat:`, `fix:`, `ci:`, `infra:`, `chore:`.
- Run locally before pushing (same commands as CI):
  npm ci && npm run lint && npm run check && npm run test:unit

## Dependency updates

- Dependabot groups minor and patch updates per ecosystem (`.github/dependabot.yml`);
  majors arrive as individual pull requests and are read one at a time.
- A patch-level update merges itself once the three-job gate (`validate`, `container`,
  `infra`) is green. The workflow waits for the whole gate rather than using GitHub
  auto-merge, because `main` requires no status checks: `--auto` would merge as soon as
  the pull request was mergeable, while `container` and `infra` were still running.
- Anything that is not a readable patch — a minor, a major, a base-image tag such as
  `24-alpine`, or a branch edited by hand — waits for a human. A green pipeline is not
  the same thing as a correct change.
- A merge that only moves dependency inputs — the npm manifests and lockfiles, the
  action versions under `.github`, the container base image in the `Dockerfile` — does
  not deploy the static site. If such a change is expected to alter what is served,
  dispatch the `Deploy Static Site via AWS CDK` workflow by hand.

## Infrastructure deploys

Three workflows touch production, and they are not interchangeable:

- `deploy-static.yml` deploys `StaticSiteStack` (S3 + CloudFront) on a push that
  can change what is served, and by hand after a dependency-only change.
- `deploy-infra.yml` deploys `EcsServiceStack`, behind the `production`
  environment, and runs the post-deploy smoke test afterwards. It skips
  dependency-only pushes, so **dispatch it by hand after a CDK library bump** —
  a new `aws-cdk-lib` can change the synthesised template.
- `deploy-container.yml` only re-pulls the published image against the task
  definition. It does not apply stack changes, so anything that alters the task
  definition, the service or its parameters needs `deploy-infra.yml`. Merging is
  not deploying for this stack; a change can be reviewed, released and still not
  be in the environment it describes.

## Rolling back

A bad release is reverted by pinning the previous `sha-<short>` image tag into a new task-definition
revision — not by pointing the service at an older revision, because every revision pulls the mutable
`:latest` and that would only restart the current code. The break-glass procedure, the permissions it
needs, the checks that prove the old build is actually serving, and the measured rehearsal from
2026-10-28 are in [docs/rollback.md](docs/rollback.md). The database is forward-only: a bad migration
is fixed by a new migration, never by a rollback.

## Content

Posts, authors and drills are content collections under `src/content/`, validated by
the schemas in `src/content-schema.ts` both at build time and by
`src/content-schema.test.ts`. Bad frontmatter therefore fails `npm run check` or the
unit tests, rather than rendering an empty page.

A drill is one markdown file in `src/content/drills/`: adding to the catalogue is a
markdown-only pull request. Its filename becomes the slug and has to match the
`session_drills.drill_slug` pattern in the migrations, and its `measures` list names
the columns a logged session records for it (`makes` and `attempts` together, `sets`,
`reps`, `weight_kg`) — so a drill cannot promise a number the tables cannot store.

## Data access

`src/utils/db.ts` is the only module that builds a database client, and the
stores beside it (`sessions.ts`, `tracker-cache.ts`, `upstream-budget.ts`) are the
only modules that query one. A page never imports `@supabase/supabase-js` — the
`no-restricted-imports` rule in `eslint.config.js` fails the build if one does —
so a route stays thin and the shape it renders is decided in one place.

Nothing in there throws. A missing credential, an unreachable database and a
refused statement all come back as a `Result`, because a container with no
credentials still has to serve pages (#94).

The tracker's two routes are both SSR: `/nba` renders the day's slate
(`?date=YYYY-MM-DD` for another day) and `/nba/game/<id>` renders one game. Each
page calls `refreshSlate` for the day it is about and renders whatever the cache
holds, including when that refresh was refused — the TTL rules in
`slate-ingest.ts` decide what a view costs, and a day upstream reported as empty
is remembered in `slate_days` so the empty state costs nothing. `slate-view.ts`
turns cached rows into the labels and tables both pages print, so the two cannot
disagree about whether a game is live.

The tests fake the client (`src/utils/testing/fake-supabase.ts`) rather than
reaching a network, so `npm run test:unit` passes offline: the suite runs with
all network access denied and still passes, which is also why CI can run it with
no credentials at all.

## Database migrations

The schema lives in `supabase/migrations/` and is applied in filename order.
`npx supabase migration new <name>` writes the next file; anything hand-written
belongs in one of these files rather than in a dashboard, because a migration is
the only version of a schema change that can be reviewed and replayed.

- **Locally**, `npx supabase db reset` rebuilds the local stack from the
  migrations plus `supabase/seed.sql`. It is the fastest way to find out that a
  migration does not apply to an empty database, and nothing else checks that
  for you.
- **To production**, dispatch the `Apply Database Migrations` workflow. Its first
  job runs outside the approval and checks that the connection can work at all —
  the secret is set, the password is not still the dashboard's
  `[YOUR-PASSWORD]` placeholder, the host has an IPv4 route, and a read-only
  `migration list` proves the credentials connect — so a reviewer is never asked
  to approve a run that was never going to reach the database. The gated job then
  applies the pending migrations and writes what was applied and the resulting
  schema version to the run summary. A dispatch with nothing pending is a no-op
  that reports success.
- Its only credential is the `SUPABASE_DB_URL` repository secret: the **session**
  pooler connection string on port 5432, with the project's database password
  substituted. A free-tier project has no direct IPv4 route, and the transaction
  pooler on 6543 cannot run migrations.
- Do not run `supabase db push` from a laptop. The point of the workflow is that
  the schema change which reaches production is the one this repository holds,
  with an approval recorded against it.

## Releases (container image)

- Semver tags: v1.0.0, v1.1.0, ...
- Every image also tagged sha-<shortsha> for traceability.
- Merging to `main` publishes the image automatically; the ECS rollout is gated by the
  `production` environment and waits for a reviewer to approve it in the Actions UI.
  Nothing reaches production without that approval.
