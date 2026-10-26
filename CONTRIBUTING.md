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
- A merge that only touches dependency manifests and lockfiles does not deploy the
  static site. If such a change is expected to alter what is served, dispatch the
  `Deploy Static Site via AWS CDK` workflow by hand.

## Releases (container image)

- Semver tags: v1.0.0, v1.1.0, ...
- Every image also tagged sha-<shortsha> for traceability.
- Merging to `main` publishes the image automatically; the ECS rollout is gated by the
  `production` environment and waits for a reviewer to approve it in the Actions UI.
  Nothing reaches production without that approval.
