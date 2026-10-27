import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import { EcsServiceStack } from '../lib/ecs-service-stack';

const PARAMETERS = [
  'supabase-url',
  'supabase-service-role-key',
  'balldontlie-api-key',
  'nba-daily-request-budget',
];

const VARIABLES = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'BALLDONTLIE_API_KEY',
  'NBA_DAILY_REQUEST_BUDGET',
];

// Synthesised without `env` on purpose: the stack then resolves its availability
// zones with Fn::GetAZs instead of a context lookup, so these tests need neither
// AWS credentials nor a populated cdk.context.json -- the same property CI's
// `cdk synth` depends on.
function synthStack(parameterPrefix?: string): Template {
  const app = new cdk.App();
  const stack = new EcsServiceStack(
    app,
    'TestEcsServiceStack',
    parameterPrefix ? { parameterPrefix } : {},
  );
  return Template.fromStack(stack);
}

function container(template: Template) {
  const taskDefinitions = template.findResources('AWS::ECS::TaskDefinition');
  const definitions = Object.values(taskDefinitions)[0].Properties.ContainerDefinitions;
  return definitions[0] as {
    Environment: Array<{ Name: string; Value: string }>;
    Secrets: Array<{ Name: string; ValueFrom: unknown }>;
  };
}

describe('EcsServiceStack — credentials reach the container (#94)', () => {
  const template = synthStack();
  const json = JSON.stringify(template.toJSON());

  it('injects all four variables as container secrets', () => {
    const names = container(template).Secrets.map((s) => s.Name).sort();
    expect(names).toEqual([...VARIABLES].sort());
  });

  it('reads each one from the SSM prefix, by parameter ARN', () => {
    for (const parameter of PARAMETERS) {
      expect(json).toContain(`parameter/blog/${parameter}`);
    }

    // ECS resolves these itself with the execution role. A `resolve:ssm-secure`
    // dynamic reference would instead be substituted by CloudFormation at deploy
    // time, which is how a secret ends up in a template and in every `cdk diff`.
    const valueFrom = JSON.stringify(container(template).Secrets.map((s) => s.ValueFrom));
    expect(valueFrom).not.toContain('resolve:');
  });

  it('passes nothing credential-shaped as plain environment', () => {
    expect(container(template).Environment).toEqual([{ Name: 'NODE_ENV', Value: 'production' }]);
  });

  it('creates no parameters of its own, so no value can be in the template', () => {
    template.resourceCountIs('AWS::SSM::Parameter', 0);
  });

  it('grants the task execution role read access to those parameters, and only to them', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const policy = Object.values(policies).find((p) =>
      JSON.stringify(p.Properties).includes('ssm:GetParameters'),
    );
    expect(policy).toBeDefined();

    const statements = policy!.Properties.PolicyDocument.Statement as Array<{
      Action: string | string[];
      Effect: string;
      Resource: unknown;
    }>;
    // CDK emits one statement per parameter, each scoped to that parameter ARN.
    const read = statements.filter((s) => JSON.stringify(s.Action).includes('ssm:GetParameters'));
    expect(read.length).toBeGreaterThanOrEqual(PARAMETERS.length);
    expect(read.every((s) => s.Effect === 'Allow')).toBe(true);

    const resources = JSON.stringify(read.map((s) => s.Resource));
    for (const parameter of PARAMETERS) {
      expect(resources).toContain(`parameter/blog/${parameter}`);
    }
    // Scoped to the parameters themselves -- no wildcard SSM read.
    expect(resources).not.toContain('parameter/blog/*');
    expect(resources).not.toContain('"*"');

    // The grant has to sit on the execution role -- that is the principal ECS
    // uses to fetch a secret before the container starts. On the task role it
    // would never be exercised.
    const roleRefs = policy!.Properties.Roles as Array<{ Ref: string }>;
    expect(roleRefs).toHaveLength(1);
    const role = template.toJSON().Resources[roleRefs[0].Ref];
    expect(JSON.stringify(role.Properties.AssumeRolePolicyDocument)).toContain(
      'ecs-tasks.amazonaws.com',
    );
  });

  it('honours a custom parameter prefix', () => {
    const custom = JSON.stringify(synthStack('/cs4421-astro-blog').toJSON());
    expect(custom).toContain('parameter/cs4421-astro-blog/supabase-service-role-key');
    expect(custom).not.toContain('parameter/blog/');
  });
});
