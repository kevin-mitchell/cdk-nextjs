import * as fs from 'node:fs';
import * as path from 'path';
import { Duration, Fn, RemovalPolicy } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { Distribution, ResponseHeadersPolicy } from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Patterns from 'aws-cdk-lib/aws-route53-patterns';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { DEFAULT_STATIC_MAX_AGE, NEXTJS_BUILD_DIR, NEXTJS_STATIC_DIR } from './constants';
import { BaseSiteDomainProps, NextjsBaseProps } from './NextjsBase';
import { NextjsBuild } from './NextjsBuild';

export interface NextjsDomainProps extends BaseSiteDomainProps {}

export type NextjsDistributionCdkOverrideProps = cloudfront.DistributionProps;

export interface NextjsDistributionCdkProps {
  /**
   * Pass in a value to override the default settings this construct uses to
   * create the CloudFront `Distribution` internally.
   */
  readonly distribution?: NextjsDistributionCdkOverrideProps;
}

export interface NextjsCachePolicyProps {
  readonly staticResponseHeaderPolicy?: ResponseHeadersPolicy;
  readonly staticCachePolicy?: cloudfront.ICachePolicy;
  readonly serverCachePolicy?: cloudfront.ICachePolicy;
  readonly imageCachePolicy?: cloudfront.ICachePolicy;

  /**
   * Cache-control max-age default for static assets (/_next/*).
   * Default: 30 days.
   */
  readonly staticClientMaxAgeDefault?: Duration;
}

export interface NextjsOriginRequestPolicyProps {
  readonly serverOriginRequestPolicy?: cloudfront.IOriginRequestPolicy;
  readonly imageOptimizationOriginRequestPolicy?: cloudfront.IOriginRequestPolicy;
}

export interface NextjsDistributionProps extends NextjsBaseProps {
  /**
   * Bucket containing static assets.
   * Must be provided if you want to serve static files.
   */
  readonly staticAssetsBucket: s3.IBucket;

  /**
   * Lambda function to route all non-static requests to.
   * Must be provided if you want to serve dynamic requests.
   */
  readonly serverFunction: lambda.IFunction;

  /**
   * Lambda function to optimize images.
   * Must be provided if you want to serve dynamic requests.
   */
  readonly imageOptFunction: lambda.IFunction;

  /**
   * Overrides for created CDK resources.
   */
  readonly cdk?: NextjsDistributionCdkProps;

  /**
   * Built NextJS app.
   */
  readonly nextBuild: NextjsBuild;

  /**
   * Override the default CloudFront cache policies created internally.
   */
  readonly cachePolicies?: NextjsCachePolicyProps;

  /**
   * Override the default CloudFront origin request policies created internally.
   */
  readonly originRequestPolicies?: NextjsOriginRequestPolicyProps;

  /**
   * The customDomain for this website. Supports domains that are hosted
   * either on [Route 53](https://aws.amazon.com/route53/) or externally.
   *
   * Note that you can also migrate externally hosted domains to Route 53 by
   * [following this guide](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/MigratingDNS.html).
   *
   * @example
   * new NextjsDistribution(this, "Dist", {
   *   customDomain: "domain.com",
   * });
   *
   * new NextjsDistribution(this, "Dist", {
   *   customDomain: {
   *     domainName: "domain.com",
   *     domainAlias: "www.domain.com",
   *     hostedZone: "domain.com"
   *   },
   * });
   */
  readonly customDomain?: string | NextjsDomainProps;

  /**
   * Include the name of your deployment stage if present.
   * Used to name the edge functions stack.
   * Required if using SST.
   */
  readonly stageName?: string;

  /**
   * Optional value to prefix the edge function stack
   * It defaults to "Nextjs"
   */
  readonly stackPrefix?: string;

  /**
   * Override lambda function url auth type
   * @default "NONE"
   */
  readonly functionUrlAuthType?: lambda.FunctionUrlAuthType;

  /**
   * Optional value to prefix the Next.js site under a /prefix path on CloudFront.
   * Usually used when you deploy multiple Next.js sites on same domain using /sub-path
   *
   * Note, you'll need to set [basePath](https://nextjs.org/docs/app/api-reference/next-config-js/basePath)
   * in your `next.config.ts` to this value and ensure any files in `public`
   * folder have correct prefix.
   * @example "/my-base-path"
   */
  readonly basePath?: string;

  /**
   * Optional CloudFront Distribution created outside of this construct that will
   * be used to add Next.js behaviors and origins onto. Useful with `basePath`.
   */
  readonly distribution?: Distribution;
}

/**
 * Create a CloudFront distribution to serve a Next.js application.
 */
export class NextjsDistribution extends Construct {
  /**
   * The default CloudFront cache policy properties for dynamic requests to server handler.
   */
  public static serverCachePolicyProps: cloudfront.CachePolicyProps = {
    queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
    headerBehavior: cloudfront.CacheHeaderBehavior.allowList(
      'accept',
      'rsc',
      'next-router-prefetch',
      'next-router-state-tree',
      'next-url'
    ),
    cookieBehavior: cloudfront.CacheCookieBehavior.all(),
    defaultTtl: Duration.seconds(0),
    maxTtl: Duration.days(365),
    minTtl: Duration.seconds(0),
    enableAcceptEncodingBrotli: true,
    enableAcceptEncodingGzip: true,
    comment: 'Nextjs Server Default Cache Policy',
  };

  /**
   * The default CloudFront Cache Policy properties for images.
   */
  public static imageCachePolicyProps: cloudfront.CachePolicyProps = {
    queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
    headerBehavior: cloudfront.CacheHeaderBehavior.allowList('accept'),
    cookieBehavior: cloudfront.CacheCookieBehavior.all(),
    defaultTtl: Duration.days(1),
    maxTtl: Duration.days(365),
    minTtl: Duration.days(0),
    enableAcceptEncodingBrotli: true,
    enableAcceptEncodingGzip: true,
    comment: 'Nextjs Image Default Cache Policy',
  };

  protected props: NextjsDistributionProps;

  /////////////////////
  // Public Properties
  /////////////////////
  /**
   * The internally created CloudFront `Distribution` instance.
   */
  public distribution: Distribution;
  /**
   * The Route 53 hosted zone for the custom domain.
   */
  hostedZone?: route53.IHostedZone;
  /**
   * The AWS Certificate Manager certificate for the custom domain.
   */
  certificate?: acm.ICertificate;

  private commonBehaviorOptions: Pick<cloudfront.BehaviorOptions, 'viewerProtocolPolicy' | 'compress'> = {
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    compress: true,
  };

  private s3Origin: origins.S3Origin;

  private staticBehaviorOptions: cloudfront.BehaviorOptions;

  private edgeLambdas: cloudfront.EdgeLambda[] = [];

  private serverBehaviorOptions: cloudfront.BehaviorOptions;

  private imageBehaviorOptions: cloudfront.BehaviorOptions;

  constructor(scope: Construct, id: string, props: NextjsDistributionProps) {
    super(scope, id);

    this.props = props;

    // Create Custom Domain
    this.validateCustomDomainSettings();
    this.hostedZone = this.lookupHostedZone();
    this.certificate = this.createCertificate();

    // Create Behaviors
    this.s3Origin = new origins.S3Origin(this.props.staticAssetsBucket);
    this.staticBehaviorOptions = this.createStaticBehaviorOptions();
    if (this.isFnUrlIamAuth) {
      this.edgeLambdas.push(this.createEdgeLambda());
    }
    this.serverBehaviorOptions = this.createServerBehaviorOptions();
    this.imageBehaviorOptions = this.createImageBehaviorOptions();

    // Create CloudFront Distribution
    this.distribution = this.getCloudFrontDistribution();
    this.addStaticBehaviorsToDistribution();
    this.addRootPathBehavior();

    // Connect Custom Domain to CloudFront Distribution
    this.createRoute53Records();
  }

  /**
   * The CloudFront URL of the website.
   */
  public get url(): string {
    return `https://${this.distribution.distributionDomainName}`;
  }

  get customDomainName(): string | undefined {
    const { customDomain } = this.props;

    if (!customDomain) {
      return;
    }

    if (typeof customDomain === 'string') {
      return customDomain;
    }

    return customDomain.domainName;
  }

  /**
   * If the custom domain is enabled, this is the URL of the website with the
   * custom domain.
   */
  public get customDomainUrl(): string | undefined {
    const customDomainName = this.customDomainName;
    return customDomainName ? `https://${customDomainName}` : undefined;
  }

  /**
   * The ID of the internally created CloudFront Distribution.
   */
  public get distributionId(): string {
    return this.distribution.distributionId;
  }

  /**
   * The domain name of the internally created CloudFront Distribution.
   */
  public get distributionDomain(): string {
    return this.distribution.distributionDomainName;
  }

  private get isFnUrlIamAuth() {
    return this.props.functionUrlAuthType === lambda.FunctionUrlAuthType.AWS_IAM;
  }

  private createStaticBehaviorOptions(): cloudfront.BehaviorOptions {
    const staticClientMaxAge = this.props.cachePolicies?.staticClientMaxAgeDefault || DEFAULT_STATIC_MAX_AGE;
    // TODO: remove this response headers policy once S3 files have correct cache control headers with new asset deployment technique
    const responseHeadersPolicy =
      this.props.cachePolicies?.staticResponseHeaderPolicy ??
      new ResponseHeadersPolicy(this, 'StaticResponseHeadersPolicy', {
        // add default header for static assets
        customHeadersBehavior: {
          customHeaders: [
            {
              header: 'cache-control',
              override: false,
              // by default tell browser to cache static files for this long
              // this is separate from the origin cache policy
              value: `public,max-age=${staticClientMaxAge},immutable`,
            },
          ],
        },
      });
    const cachePolicy = this.props.cachePolicies?.staticCachePolicy ?? cloudfront.CachePolicy.CACHING_OPTIMIZED;
    return {
      ...this.commonBehaviorOptions,
      origin: this.s3Origin,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
      cachePolicy,
      responseHeadersPolicy,
    };
  }

  private get fnUrlAuthType(): lambda.FunctionUrlAuthType {
    return this.props.functionUrlAuthType || lambda.FunctionUrlAuthType.NONE;
  }

  /**
   * Once CloudFront OAC is released, remove this to reduce latency.
   */
  private createEdgeLambda(): cloudfront.EdgeLambda {
    const signFnUrlDir = path.resolve(__dirname, '..', 'assets', 'lambdas', 'sign-fn-url');
    const originRequestEdgeFn = new cloudfront.experimental.EdgeFunction(this, 'EdgeFn', {
      runtime: Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(signFnUrlDir),
      currentVersionOptions: {
        removalPolicy: RemovalPolicy.DESTROY, // destroy old versions
        retryAttempts: 1, // async retry attempts
      },
    });
    originRequestEdgeFn.currentVersion.grantInvoke(new ServicePrincipal('edgelambda.amazonaws.com'));
    originRequestEdgeFn.currentVersion.grantInvoke(new ServicePrincipal('lambda.amazonaws.com'));
    originRequestEdgeFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['lambda:InvokeFunctionUrl'],
        resources: [this.props.serverFunction.functionArn, this.props.imageOptFunction.functionArn],
      })
    );
    const originRequestEdgeFnVersion = lambda.Version.fromVersionArn(
      this,
      'Version',
      originRequestEdgeFn.currentVersion.functionArn
    );
    return {
      eventType: cloudfront.LambdaEdgeEventType.ORIGIN_REQUEST,
      functionVersion: originRequestEdgeFnVersion,
      includeBody: true,
    };
  }

  private createServerBehaviorOptions(): cloudfront.BehaviorOptions {
    const fnUrl = this.props.serverFunction.addFunctionUrl({ authType: this.fnUrlAuthType });
    const origin = new origins.HttpOrigin(Fn.parseDomainName(fnUrl.url));
    const originRequestPolicy =
      this.props.originRequestPolicies?.serverOriginRequestPolicy ??
      cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER;
    const cachePolicy =
      this.props.cachePolicies?.serverCachePolicy ??
      new cloudfront.CachePolicy(this, 'ServerCachePolicy', NextjsDistribution.serverCachePolicyProps);
    return {
      ...this.commonBehaviorOptions,
      origin,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      originRequestPolicy,
      cachePolicy,
      edgeLambdas: this.edgeLambdas.length ? this.edgeLambdas : undefined,
      functionAssociations: this.createCloudFrontFnAssociations(),
    };
  }

  /**
   * If this doesn't run, then Next.js Server's `request.url` will be Lambda Function
   * URL instead of domain
   */
  private createCloudFrontFnAssociations() {
    const cloudFrontFn = new cloudfront.Function(this, 'CloudFrontFn', {
      code: cloudfront.FunctionCode.fromInline(`
      function handler(event) {
        var request = event.request;
        request.headers["x-forwarded-host"] = request.headers.host;
        return request;
      }
      `),
    });
    return [{ eventType: cloudfront.FunctionEventType.VIEWER_REQUEST, function: cloudFrontFn }];
  }

  private createImageBehaviorOptions(): cloudfront.BehaviorOptions {
    const imageOptFnUrl = this.props.imageOptFunction.addFunctionUrl({ authType: this.fnUrlAuthType });
    const origin = new origins.HttpOrigin(Fn.parseDomainName(imageOptFnUrl.url));
    const originRequestPolicy =
      this.props.originRequestPolicies?.imageOptimizationOriginRequestPolicy ??
      cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER;
    const cachePolicy =
      this.props.cachePolicies?.imageCachePolicy ??
      new cloudfront.CachePolicy(this, 'ImageCachePolicy', NextjsDistribution.imageCachePolicyProps);
    return {
      ...this.commonBehaviorOptions,
      origin,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
      cachePolicy,
      originRequestPolicy,
      edgeLambdas: this.edgeLambdas,
    };
  }

  /**
   * Creates or uses user specified CloudFront Distribution adding behaviors
   * needed for Next.js.
   */
  private getCloudFrontDistribution(): cloudfront.Distribution {
    let distribution: cloudfront.Distribution;
    if (this.props.distribution) {
      if (this.props.cdk?.distribution) {
        throw new Error(
          'You can either pass an existing "distribution" or pass configs to create one via "cdk.distribution".'
        );
      }

      distribution = this.props.distribution;
    } else {
      distribution = this.createCloudFrontDistribution();
    }

    distribution.addBehavior(
      this.getPathPattern('api/*'),
      this.serverBehaviorOptions.origin,
      this.serverBehaviorOptions
    );
    distribution.addBehavior(
      this.getPathPattern('_next/data/*'),
      this.serverBehaviorOptions.origin,
      this.serverBehaviorOptions
    );
    distribution.addBehavior(
      this.getPathPattern('_next/image*'),
      this.imageBehaviorOptions.origin,
      this.imageBehaviorOptions
    );

    return distribution;
  }

  /**
   * Creates default CloudFront Distribution. Note, this construct will not
   * create a CloudFront Distribution if one is passed in by user.
   */
  private createCloudFrontDistribution(cfDistributionProps?: NextjsDistributionCdkOverrideProps) {
    // build domainNames
    const domainNames = this.buildDistributionDomainNames();

    return new cloudfront.Distribution(this, 'Distribution', {
      // defaultRootObject: "index.html",
      defaultRootObject: '',
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,

      // Override props.
      ...cfDistributionProps,

      // these values can NOT be overwritten by cfDistributionProps
      domainNames,
      certificate: this.certificate,
      defaultBehavior: this.serverBehaviorOptions,
    });
  }

  /**
   * this needs to be added last so that it doesn't override any other behaviors
   * when basePath is set, we emulate the "default behavior" (*) and / as `/base-path/*`
   * @private
   */
  private addRootPathBehavior() {
    // if we don't have a static file called index.html then we should
    // redirect to the lambda handler
    const hasIndexHtml = this.props.nextBuild.readPublicFileList().includes('index.html');
    if (hasIndexHtml) return; // don't add root path behavior

    const { origin, ...options } = this.serverBehaviorOptions;

    // when basePath is set, we emulate the "default behavior" (*) for the site as `/base-path/*`
    if (this.props.basePath) {
      this.distribution.addBehavior(this.getPathPattern(''), origin, options);
      this.distribution.addBehavior(this.getPathPattern('*'), origin, options);
    } else {
      this.distribution.addBehavior(this.getPathPattern('/'), origin, options);
    }
  }

  private addStaticBehaviorsToDistribution() {
    const publicFiles = fs.readdirSync(path.join(this.props.nextjsPath, NEXTJS_BUILD_DIR, NEXTJS_STATIC_DIR), {
      withFileTypes: true,
    });
    if (publicFiles.length >= 25) {
      throw new Error(
        `Too many public/ files in Next.js build. CloudFront limits Distributions to 25 Cache Behaviors. See documented limit here: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html#limits-web-distributions`
      );
    }
    for (const publicFile of publicFiles) {
      const pathPattern = publicFile.isDirectory() ? `${publicFile.name}/*` : publicFile.name;
      if (!/^[a-zA-Z0-9_\-\.\*\$/~"'@:+?&]+$/.test(pathPattern)) {
        throw new Error(
          `Invalid CloudFront Distribution Cache Behavior Path Pattern: ${pathPattern}. Please see documentation here: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-web-values-specify.html#DownloadDistValuesPathPattern`
        );
      }
      const finalPathPattern = this.getPathPattern(pathPattern);
      this.distribution.addBehavior(finalPathPattern, this.s3Origin, this.staticBehaviorOptions);
    }
  }

  /**
   * Optionally prepends base path to given path pattern.
   */
  private getPathPattern(pathPattern: string) {
    if (this.props.basePath) {
      // because we already have a basePath we don't use / instead we use /base-path
      if (pathPattern === '') return this.props.basePath;
      return `${this.props.basePath}/${pathPattern}`;
    }

    return pathPattern;
  }

  private buildDistributionDomainNames(): string[] {
    const customDomain =
      typeof this.props.customDomain === 'string' ? this.props.customDomain : this.props.customDomain?.domainName;

    const alternateNames =
      typeof this.props.customDomain === 'string' ? [] : this.props.customDomain?.alternateNames || [];

    return customDomain ? [customDomain, ...alternateNames] : [];
  }

  /////////////////////
  // Custom Domain
  /////////////////////

  protected validateCustomDomainSettings() {
    const { customDomain } = this.props;

    if (!customDomain) {
      return;
    }

    if (typeof customDomain === 'string') {
      return;
    }

    if (customDomain.isExternalDomain === true) {
      if (!customDomain.certificate) {
        throw new Error('A valid certificate is required when "isExternalDomain" is set to "true".');
      }
      if (customDomain.domainAlias) {
        throw new Error(
          'Domain alias is only supported for domains hosted on Amazon Route 53. Do not set the "customDomain.domainAlias" when "isExternalDomain" is enabled.'
        );
      }
      if (customDomain.hostedZone) {
        throw new Error(
          'Hosted zones can only be configured for domains hosted on Amazon Route 53. Do not set the "customDomain.hostedZone" when "isExternalDomain" is enabled.'
        );
      }
    }
  }

  protected lookupHostedZone(): route53.IHostedZone | undefined {
    const { customDomain } = this.props;

    // Skip if customDomain is not configured
    if (!customDomain) {
      return;
    }

    let hostedZone;

    if (typeof customDomain === 'string') {
      hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
        domainName: customDomain,
      });
    } else if (typeof customDomain.hostedZone === 'string') {
      hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
        domainName: customDomain.hostedZone,
      });
    } else if (customDomain.hostedZone) {
      hostedZone = customDomain.hostedZone;
    } else if (typeof customDomain.domainName === 'string') {
      // Skip if domain is not a Route53 domain
      if (customDomain.isExternalDomain === true) {
        return;
      }

      hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
        domainName: customDomain.domainName,
      });
    } else {
      hostedZone = customDomain.hostedZone;
    }

    return hostedZone;
  }

  private createCertificate(): acm.ICertificate | undefined {
    const { customDomain } = this.props;

    if (!customDomain) {
      return;
    }

    let acmCertificate;

    // HostedZone is set for Route 53 domains
    if (this.hostedZone) {
      if (typeof customDomain === 'string') {
        acmCertificate = new acm.DnsValidatedCertificate(this, 'Certificate', {
          domainName: customDomain,
          hostedZone: this.hostedZone,
          region: 'us-east-1',
        });
      } else if (customDomain.certificate) {
        acmCertificate = customDomain.certificate;
      } else {
        acmCertificate = new acm.DnsValidatedCertificate(this, 'Certificate', {
          domainName: customDomain.domainName,
          hostedZone: this.hostedZone,
          region: 'us-east-1',
        });
      }
    }
    // HostedZone is NOT set for non-Route 53 domains
    else {
      if (typeof customDomain !== 'string') {
        acmCertificate = customDomain.certificate;
      }
    }

    return acmCertificate;
  }

  private createRoute53Records(): void {
    const { customDomain } = this.props;

    if (!customDomain || !this.hostedZone) {
      return;
    }

    let recordName;
    let domainAlias;
    if (typeof customDomain === 'string') {
      recordName = customDomain;
    } else {
      recordName = customDomain.domainName;
      domainAlias = customDomain.domainAlias;
    }

    // Create DNS record
    const recordProps = {
      recordName,
      zone: this.hostedZone,
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(this.distribution)),
    };
    new route53.ARecord(this, 'AliasRecord', recordProps);
    new route53.AaaaRecord(this, 'AliasRecordAAAA', recordProps);

    // Create Alias redirect record
    if (domainAlias) {
      new route53Patterns.HttpsRedirect(this, 'Redirect', {
        zone: this.hostedZone,
        recordNames: [domainAlias],
        targetDomain: recordName,
      });
    }
  }
}
