# Welcome to your CDK TypeScript project

This is a blank project for CDK development with TypeScript.

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Useful commands

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `npx cdk deploy`  deploy this stack to your default AWS account/region
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template

Both stacks are pinned to `us-east-1` in `bin/static-site.ts`. The AWS CLI's
profile default may be elsewhere, so pass `--region us-east-1` on any hand-run
`cdk` or `aws` command rather than trusting the ambient configuration.

## Credentials (#94)

`EcsServiceStack` gives the container its credentials as SSM Parameter Store
references, not as environment values written into the template:

| Parameter | Type | Container variable |
| --- | --- | --- |
| `/blog/supabase-url` | String | `SUPABASE_URL` |
| `/blog/supabase-service-role-key` | SecureString | `SUPABASE_SERVICE_ROLE_KEY` |
| `/blog/balldontlie-api-key` | SecureString | `BALLDONTLIE_API_KEY` |
| `/blog/nba-daily-request-budget` | String | `NBA_DAILY_REQUEST_BUDGET` |

The stack deliberately does **not** create them. CloudFormation cannot create a
`SecureString` without carrying the plaintext in the template, and a template is
uploaded to S3, rendered in the console and printed by every `cdk diff`. The
values are put in place out of band by `../scripts/put-ssm-parameters.sh`, which
reads them from `.env` and leaves existing parameters alone unless `--overwrite`
is passed, so running it twice cannot rotate a credential out from under a
running task.

The task definition's `secrets` block is what grants the task execution role
`ssm:GetParameters` on those four ARNs, so the permission is never hand-added in
the console and cannot drift from the deployment;
`test/ecs-service.test.ts` asserts both the grant and the fact that nothing
credential-shaped travels as a plain `environment` value.

**Create the parameters before deploying.** ECS resolves `valueFrom` when it
starts a task, so a missing parameter fails the rollout -- with the service's
circuit breaker rolling it back -- rather than failing quietly at runtime.
`cdk synth` and `npm test` need neither credentials nor parameters, because they
only ever reference the names.
