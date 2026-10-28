# Rolling back a release

A rollback here means putting the previous known-good build back in front of users, on purpose,
while someone is watching. This document is the procedure, the permissions it needs, and the record
of the rehearsal on 2026-10-28 (#45).

Two things can be rolled back — the container that serves the SSR pages, and the static site — and
one cannot: the database schema. The difference matters and is the reason this file starts with a
decision, not a command.

## Decide first

| What is wrong | Roll back? |
| --- | --- |
| The last release changed behaviour wrongly (bad page, wrong copy, broken route) | Yes — container |
| The post-deploy smoke test failed on a rollout that did finish | Yes — container |
| The static site is serving a bad build | Yes — static site (see below) |
| A migration was applied and is wrong | No — forward fix with a new migration |
| The slate shows the wrong numbers | No — that is cached data; re-ingest the day |
| Upstream is down and pages say the snapshot is stale | No — that is the designed state, not a fault |

A rollback is a break-glass action: it does not go through a pull request, a `validate` check or the
`production` environment approval. Whatever restores service must be written down afterwards —
a comment on the issue, or the PR that fixes the cause — because the pipeline's own record will not
contain it.

## Pick the previous known-good tag

Only `sha-<short>` identifies a build. Every release also pushes `v<package.json version>` and
`latest`, and the version is never bumped, so `v1.0.0` has referred to every image ever released and
`latest` moves with each merge. Pin the `sha-` tag, never the other two.

```bash
aws ecr describe-images --region us-east-1 --repository-name astro-blog \
  --query 'reverse(sort_by(imageDetails,&imagePushedAt))[:5].{pushed:imagePushedAt,tags:imageTags,digest:imageDigest}' \
  --output table
```

Take the newest `sha-` tag you know was serving correctly.

## The trap: an older task-definition revision is not an older image

Revisions 2 and 3 of `EcsServiceStackBlogTaskFC957AFB` both name `astro-blog:latest`. Pointing the
service at an older revision therefore restarts the tasks and pulls **whatever `latest` is now** —
the same code, a fresh start, and a log line claiming a rollback. To roll back the code you have to
pin the image tag in a new revision.

## Procedure: pinned rollback (break-glass)

**1. Copy the current revision and pin the tag.**

```bash
aws ecs describe-task-definition --region us-east-1 \
  --task-definition EcsServiceStackBlogTaskFC957AFB:<current> --query taskDefinition > /tmp/td.json

python3 - <<'PY'
import json
td = json.load(open('/tmp/td.json'))
for key in ('taskDefinitionArn','revision','status','requiresAttributes',
            'compatibilities','registeredAt','registeredBy','deregisteredAt'):
    td.pop(key, None)
td['containerDefinitions'][0]['image'] = (
    '678360599804.dkr.ecr.us-east-1.amazonaws.com/astro-blog:sha-<short>')
json.dump(td, open('/tmp/td-rollback.json','w'), indent=1)
PY

aws ecs register-task-definition --region us-east-1 \
  --cli-input-json file:///tmp/td-rollback.json \
  --query 'taskDefinition.{rev:revision,image:containerDefinitions[0].image}'
```

**2. Point the service at it, and let the deployment exist before waiting.**

```bash
date -u +"start=%FT%TZ"
aws ecs update-service --region us-east-1 --cluster BlogCluster --service BlogService \
  --task-definition EcsServiceStackBlogTaskFC957AFB:<new-rev> --no-cli-pager > /dev/null
sleep 15
time aws ecs wait services-stable --region us-east-1 --cluster BlogCluster --services BlogService
date -u +"stable=%FT%TZ"
```

The `sleep 15` is not superstition. `wait services-stable` polls the service as it is, so run in the
same second as `update-service` it can return in ~5 seconds because the new deployment has not been
registered yet — a number that looks like a recovery time and is not one. The waiter itself gives up
after 40 polls of 15 s (about ten minutes); a rollout that long means something is wrong, not slow.

**3. Prove the old code is actually serving.** Liveness is not identity:

```bash
aws ecs describe-services --region us-east-1 --cluster BlogCluster --services BlogService \
  --query "services[0].deployments[?status=='PRIMARY'].{td:taskDefinition,rollout:rolloutState,running:runningCount,pending:pendingCount}" \
  --output json

curl -s "$APP_URL/" | grep -o '<title>[^<]*</title>'   # must be the OLD title
curl -s "$APP_URL/" | grep -c 'href="/nba"'            # must match the OLD nav
bash scripts/smoke-deploy.sh "$APP_URL"                # must PASS
```

`smoke-deploy.sh` checks `/api/health` and `/server-time`; it passes on any working image, including
the one you are rolling away from. It proves the deployment is alive. The task-definition revision,
the page title and the task digests are what prove *which* deployment is alive:

```bash
tasks=$(aws ecs list-tasks --region us-east-1 --cluster BlogCluster \
  --service-name BlogService --query 'taskArns' --output text)
aws ecs describe-tasks --region us-east-1 --cluster BlogCluster \
  --tasks ${=tasks} --query 'tasks[*].containers[0].imageDigest' --output text
```

**4. Restore, and measure that too.** The service must go back to the revision that pulls `latest`,
not stay on the pinned one:

```bash
date -u +"start=%FT%TZ"
aws ecs update-service --region us-east-1 --cluster BlogCluster --service BlogService \
  --task-definition EcsServiceStackBlogTaskFC957AFB:<current> --no-cli-pager > /dev/null
sleep 15
time aws ecs wait services-stable --region us-east-1 --cluster BlogCluster --services BlogService
curl -s "$APP_URL/" | grep -o '<title>[^<]*</title>'
```

**Leaving the service on the pinned revision is the worst outcome of this whole procedure.** Every
later merge would report a successful deploy while `--force-new-deployment` re-pulled the pinned old
image, so the site would keep serving the rollback forever with a green pipeline.

## Procedure: move `latest` back instead (no break-glass permission)

When the operator cannot register a task definition, the same result comes through the pipeline,
more slowly and with a wider blast radius: re-run the **Release Image** workflow for the good
commit, wait for it to push `latest`, then approve the resulting **Deploy Container to AWS** run.

```bash
gh run list --workflow "Release Image" --limit 20 --json databaseId,headSha,createdAt
gh run rerun <databaseId>
```

While that runs, `latest` and `v1.0.0` point at the older build, so a concurrent deploy would ship
it too. Prefer the pinned procedure when it is available.

## What cannot be rolled back

- **The database.** Migrations are forward-only: the workflow applies the files in
  `supabase/migrations/` in order, and there is no down path. A bad migration is corrected by a new
  migration. The run summary records what was applied, which is why it is written before and after
  `supabase db push`.
- **The static site.** `Deploy Static Site via AWS CDK` deploys whatever `main` holds, so the way
  back is a revert on `main`, not a button. Re-running the workflow re-deploys today's `main`.
- **Cached data.** A wrong score in the cache is fixed by ingesting the day again, not by a deploy.

## Permissions the break-glass path needs

`aws ecs register-task-definition` passes both roles in the task definition to the ECS agent, so the
operator needs `iam:PassRole` on **both** — the task role and the execution role — or the call fails
with `AccessDeniedException … not authorized to perform: iam:PassRole`, once per role:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": [
        "arn:aws:iam::678360599804:role/EcsServiceStack-BlogTaskTaskRoleF0944F55-4qs1eDkpcss3",
        "arn:aws:iam::678360599804:role/EcsServiceStack-BlogTaskExecutionRoleA6C6BD3D-JBXZviL0pb65"
      ],
      "Condition": { "StringEquals": { "iam:PassedToService": "ecs-tasks.amazonaws.com" } }
    }
  ]
}
```

The condition keeps the grant to "hand these roles to ECS tasks", rather than "hand these roles to
anything that asks". The two ARNs are CDK-generated and change if the stack is rebuilt; while they
exist, naming them exactly is better than a `role/EcsServiceStack-*` wildcard.

## Rehearsal record — 2026-10-28

Both directions were exercised against production, from `sha-f97c534` (the site rename, PR #123) back
to `sha-cf1f50e` (the game-detail release, PR #118) and forward again.

| Step | Started (UTC) | Stable (UTC) | Waiter | Serves |
| --- | --- | --- | --- | --- |
| forward → revision 3 (recovering from the void attempt below) | 13:56:15 | 13:59:48 | 3 m 16.7 s | new name, 1 NBA link, `sha256:83403d…` |
| **rollback** → revision 4, pinned `sha-cf1f50e` | 14:11:31 | 14:14:30 | 2 m 42.6 s | `Northstar Notes`, 0 NBA links |
| **roll forward** → revision 3 | 14:16:25 | 14:19:17 | 2 m 36.2 s | new name, 1 NBA link, `sha256:83403d…` |
| void: first rollback attempt | 13:52:01 | 13:52:22 | 5.2 s | not measured — deployment did not exist yet |

Images: revision 3 pulls `astro-blog:latest` → `sha256:83403d7518cd7ab005f594afce4ca186d26f9a70bde1c5a69fa5f9fde253bd16`;
revision 4 pins `astro-blog:sha-cf1f50e` → `sha256:72519726a7a0324961990ede09871e5730c1619909d09020e0b33b6bdd751fdb`.
Both rolled with `running: 2, pending: 0, rolloutState: COMPLETED`, and the site stayed up
throughout — `minimumHealthyPercent: 100` keeps the old tasks in the target group until the new ones
pass health checks.

Revision 4 is left registered as a ready target for `sha-cf1f50e`. It resolves the tag when a task
starts, so it is tag-pinned, not digest-pinned: if that tag is ever rebuilt, revision 4 follows the
new digest.

### What the rehearsal found

1. **Revisions are not rollbacks.** Every revision points at `:latest`, so the obvious-looking
   "update the service to the previous revision" would have restarted the current code.
2. **`wait services-stable` is not a readiness check.** Polled in the same second as the update it
   returned in 5.2 s; settling ~15 s first produced the real 2–3 minute figures.
3. **The smoke test cannot tell versions apart.** It passed on the pre-rename image. Identity has to
   come from the task-definition revision, the page title and the task digest.
4. **The break-glass path was blocked for the operator.** `iam:PassRole` was missing on both roles,
   discovered one denial at a time; the procedure above is not usable without that grant.
5. **A rollout is a few minutes, not a few seconds.** Three measured rollouts took 2 m 36 s – 3 m 33 s,
   image pull included. A ten-minute wait is a failure to investigate, not a slow day.
6. **The dangerous end state is the pinned revision**, not the rollback itself: platform "stable" plus
   a pinned image means the next deploy reports success and changes nothing.
