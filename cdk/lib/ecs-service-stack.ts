import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ssm from 'aws-cdk-lib/aws-ssm';

export interface EcsServiceStackProps extends cdk.StackProps {
  /**
   * SSM Parameter Store prefix the task reads its credentials from (#94).
   *
   * The parameters are created out of band by `scripts/put-ssm-parameters.sh`,
   * never by this stack: CloudFormation has no way to create a SecureString
   * without carrying the plaintext in the template, which then sits in the
   * template S3 bucket and in every `cdk diff`. This stack only references them
   * by name and grants the task execution role read access to them.
   */
  parameterPrefix?: string;
}

export class EcsServiceStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props: EcsServiceStackProps = {}) {
    super(scope, id, props);
    const parameterPrefix = props.parameterPrefix ?? '/blog';

    // Image repository created beforehand (aws ecr create-repository --repository-name astro-blog)
    const repo = ecr.Repository.fromRepositoryName(this, 'BlogRepo', 'astro-blog');

    // No NAT gateway: tasks get public IPs in public subnets (cost-conscious for coursework)
    const vpc = new ec2.Vpc(this, 'BlogVpc', { maxAzs: 2, natGateways: 0 });

    const cluster = new ecs.Cluster(this, 'BlogCluster', {
      vpc,
      clusterName: 'BlogCluster',
    });

    const taskDef = new ecs.FargateTaskDefinition(this, 'BlogTask', {
      memoryLimitMiB: 512,
      cpu: 256,
    });

    // Credentials, read at task start rather than baked into the image. Two are
    // SecureString (encrypted with the AWS managed `aws/ssm` key, which needs no
    // additional KMS permission when the parameter is read through SSM); the URL
    // and the request budget are ordinary String parameters because they are not
    // secret and an operator benefits from reading them in the console.
    //
    // Passing them as `secrets` rather than `environment` is what grants the
    // execution role `ssm:GetParameters` on exactly these ARNs -- CDK does it in
    // ContainerDefinition.addSecret -- so the permission is never hand-added in
    // the console and cannot drift from the task definition.
    const supabaseUrl = ssm.StringParameter.fromStringParameterName(
      this,
      'SupabaseParameterUrl',
      `${parameterPrefix}/supabase-url`,
    );
    const supabaseServiceRoleKey = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      'SupabaseServiceRoleKeyParameter',
      { parameterName: `${parameterPrefix}/supabase-service-role-key` },
    );
    const balldontlieApiKey = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      'BalldontlieApiKeyParameter',
      { parameterName: `${parameterPrefix}/balldontlie-api-key` },
    );
    const nbaDailyRequestBudget = ssm.StringParameter.fromStringParameterName(
      this,
      'NbaDailyRequestBudgetParameter',
      `${parameterPrefix}/nba-daily-request-budget`,
    );

    // Matches the Dockerfile: node:24-alpine SSR server on 4321 with /api/health
    taskDef.addContainer('BlogContainer', {
      image: ecs.ContainerImage.fromEcrRepository(repo, 'latest'),
      portMappings: [{ containerPort: 4321 }],
      environment: { NODE_ENV: 'production' },
      secrets: {
        SUPABASE_URL: ecs.Secret.fromSsmParameter(supabaseUrl),
        SUPABASE_SERVICE_ROLE_KEY: ecs.Secret.fromSsmParameter(supabaseServiceRoleKey),
        BALLDONTLIE_API_KEY: ecs.Secret.fromSsmParameter(balldontlieApiKey),
        NBA_DAILY_REQUEST_BUDGET: ecs.Secret.fromSsmParameter(nbaDailyRequestBudget),
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'blog' }),
      healthCheck: {
        command: ['CMD-SHELL', 'wget -qO- http://127.0.0.1:4321/api/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(15),
      },
    });

    const service = new ecs.FargateService(this, 'BlogService', {
      cluster,
      taskDefinition: taskDef,
      serviceName: 'BlogService',
      desiredCount: 2,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      circuitBreaker: { enable: true, rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });

    const alb = new elbv2.ApplicationLoadBalancer(this, 'BlogAlb', {
      vpc,
      internetFacing: true,
    });

    const listener = alb.addListener('Http', { port: 80 });
    listener.addTargets('Ecs', {
      port: 4321,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: { path: '/api/health', interval: cdk.Duration.seconds(30) },
    });

    new cdk.CfnOutput(this, 'AppUrl', {
      value: `http://${alb.loadBalancerDnsName}`,
    });
    new cdk.CfnOutput(this, 'EcrRepositoryUri', { value: repo.repositoryUri });
    new cdk.CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    new cdk.CfnOutput(this, 'ServiceName', { value: service.serviceName });
  }
}
