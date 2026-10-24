import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';

export interface StaticSiteStackProps extends cdk.StackProps {
  /**
   * Local directory whose contents are uploaded to the bucket.
   * Overridable so unit tests can synth without a full Astro build.
   */
  siteAssetPath?: string;
}

export class StaticSiteStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props: StaticSiteStackProps = {}) {
    super(scope, id, props);
    const { siteAssetPath = './../dist/client' } = props;
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const rewriteFunction = new cloudfront.Function(this, 'IndexRewriteFunction', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.endsWith('/')) {
    request.uri += 'index.html';
  } else if (!uri.split('/').pop().includes('.')) {
    request.uri += '/index.html';
  }
  return request;
}
`),
    });

    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        functionAssociations: [
          { function: rewriteFunction, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      defaultRootObject: 'index.html',
    });

    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.asset(siteAssetPath)],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'], // Automatic CloudFront CDN cache invalidation!
    });

    new cdk.CfnOutput(this, 'CdnUrl', {
      value: `https://${distribution.distributionDomainName}`,
    });
  }
}
