import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';

export class EcsServiceStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

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

    // Matches the Dockerfile: node:24-alpine SSR server on 4321 with /api/health
    taskDef.addContainer('BlogContainer', {
      image: ecs.ContainerImage.fromEcrRepository(repo, 'latest'),
      portMappings: [{ containerPort: 4321 }],
      environment: { NODE_ENV: 'production' },
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
