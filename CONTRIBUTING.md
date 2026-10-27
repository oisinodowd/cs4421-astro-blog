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

## Database migrations

The schema lives in `supabase/migrations/` and is applied in filename order.
`npx supabase migration new <name>` writes the next file; anything hand-written
belongs in one of these files rather than in a dashboard, because a migration is
the only version of a schema change that can be reviewed and replayed.

- **Locally**, `npx supabase db reset` rebuilds the local stack from the
  migrations plus `supabase/seed.sql`. It is the fastest way to find out that a
  migration does not apply to an empty database, and nothing else checks that
  for you.
- **To production**, dispatch the `Apply Database Migrations` workflow. It
  targets the `production` environment, so it parks for a reviewer before it
  touches the database, then applies the pending migrations and writes what was
  applied and the resulting schema version to the run summary. A dispatch with
  nothing pending is a no-op that reports success.
- Its only credential is the `SUPABASE_DB_URL` repository secret: the **session**
  pooler connection string on port 5432. A free-tier project has no direct IPv4
  route, and the transaction pooler on 6543 cannot run migrations.
- Do not run `supabase db push` from a laptop. The point of the workflow is that
  the schema change which reaches production is the one this repository holds,
  with an approval recorded against it.

## Releases (container image)

- Semver tags: v1.0.0, v1.1.0, ...
- Every image also tagged sha-<shortsha> for traceability.
- Merging to `main` publishes the image automatically; the ECS rollout is gated by the
  `production` environment and waits for a reviewer to approve it in the Actions UI.
  Nothing reaches production without that approval.
