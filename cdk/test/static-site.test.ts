import * as path from 'node:path';

import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';

import { StaticSiteStack } from '../lib/static-site-stack';

// Synthesise against a tiny fixture instead of the real Astro build output, so
// the tests stay hermetic: they pass on a fresh clone without running a build.
function synthStack(): Template {
  const app = new cdk.App();
  const stack = new StaticSiteStack(app, 'TestStaticSiteStack', {
    siteAssetPath: path.join(__dirname, 'fixtures', 'site'),
  });
  return Template.fromStack(stack);
}

describe('StaticSiteStack — S3 origin bucket', () => {
  const template = synthStack();
  const buckets = template.findResources('AWS::S3::Bucket');

  it('creates exactly one bucket', () => {
    expect(Object.keys(buckets)).toHaveLength(1);
  });

  it('deletes the bucket and its objects with the stack', () => {
    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Delete',
      UpdateReplacePolicy: 'Delete',
      Properties: {
        Tags: Match.arrayWith([{ Key: 'aws-cdk:auto-delete-objects', Value: 'true' }]),
      },
    });
  });

  it('is not public: the bucket policy grants read only to CloudFront', () => {
    const policies = template.findResources('AWS::S3::BucketPolicy');
    expect(Object.keys(policies)).toHaveLength(1);

    const statements = Object.values(policies)[0].Properties.PolicyDocument.Statement as Array<{
      Principal: unknown;
      Condition?: Record<string, Record<string, unknown>>;
    }>;

    // No wildcard/anonymous principal anywhere in the policy.
    expect(statements.some((s) => s.Principal === '*')).toBe(false);

    const cloudfrontRead = statements.find(
      (s) => (s.Principal as { Service?: string }).Service === 'cloudfront.amazonaws.com',
    );
    expect(cloudfrontRead).toBeDefined();
    // Scoped to this distribution — an OAC origin, not a public bucket.
    expect(cloudfrontRead?.Condition?.StringEquals).toHaveProperty('AWS:SourceArn');
  });
});

describe('StaticSiteStack — CloudFront distribution', () => {
  const template = synthStack();
  const distributions = template.findResources('AWS::CloudFront::Distribution');

  it('creates exactly one distribution', () => {
    expect(Object.keys(distributions)).toHaveLength(1);
  });

  it('serves index.html at the root', () => {
    const config = Object.values(distributions)[0].Properties.DistributionConfig;
    expect(config.DefaultRootObject).toBe('index.html');
  });

  it('has a single S3 origin using an Origin Access Control', () => {
    const config = Object.values(distributions)[0].Properties.DistributionConfig;

    expect(config.Origins).toHaveLength(1);
    expect(config.Origins[0].S3OriginConfig).toEqual({ OriginAccessIdentity: '' });
    expect(config.Origins[0].OriginAccessControlId).toEqual({
      'Fn::GetAtt': [expect.stringContaining('S3OriginAccessControl'), 'Id'],
    });
    expect(config.Origins[0].DomainName).toEqual({
      'Fn::GetAtt': [expect.stringContaining('SiteBucket'), 'RegionalDomainName'],
    });

    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
  });

  it('rewrites extensionless paths to /index.html on viewer request', () => {
    const config = Object.values(distributions)[0].Properties.DistributionConfig;
    const associations = config.DefaultCacheBehavior.FunctionAssociations;

    expect(associations).toHaveLength(1);
    expect(associations[0].EventType).toBe('viewer-request');
    expect(associations[0].FunctionARN).toEqual({
      'Fn::GetAtt': [expect.stringContaining('IndexRewriteFunction'), 'FunctionARN'],
    });
  });

  it('defines the rewrite function as cloudfront-js-2.0 with the index-rewrite logic', () => {
    const functions = template.findResources('AWS::CloudFront::Function');
    expect(Object.keys(functions)).toHaveLength(1);

    const fn = Object.values(functions)[0].Properties;
    expect(fn.FunctionConfig.Runtime).toBe('cloudfront-js-2.0');
    // "/about" -> "/about/index.html", "/" -> "/index.html"
    expect(fn.FunctionCode).toContain("request.uri += '/index.html'");
    expect(fn.FunctionCode).toContain("request.uri += 'index.html'");
  });
});

describe('StaticSiteStack — deployment wiring', () => {
  const template = synthStack();

  it('uploads the site and invalidates the whole cache on deploy', () => {
    template.hasResourceProperties('Custom::CDKBucketDeployment', {
      DistributionId: Match.anyValue(),
      DistributionPaths: ['/*'],
      SourceBucketNames: Match.anyValue(),
      DestinationBucketName: Match.anyValue(),
    });
  });

  it('exposes the CDN URL as a stack output', () => {
    template.hasOutput('CdnUrl', {
      Value: { 'Fn::Join': ['', ['https://', { 'Fn::GetAtt': [Match.anyValue(), 'DomainName'] }]] },
    });
  });
});
