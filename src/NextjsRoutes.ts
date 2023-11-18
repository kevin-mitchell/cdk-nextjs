import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Patterns from 'aws-cdk-lib/aws-route53-patterns';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';
import { NextjsBaseProps, BaseSiteDomainProps } from './NextjsBase';

export interface NextjsDomainProps extends BaseSiteDomainProps {}

export interface NextjsRouteProps extends NextjsBaseProps {
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
}

/**
 * Responsible for creating Route53 resources.
 */
export class NextjsRoute extends Construct {
  protected props: NextjsRouteProps;

  /**
   * The Route 53 hosted zone for the custom domain.
   */
  hostedZone?: route53.IHostedZone;
  /**
   * The AWS Certificate Manager certificate for the custom domain.
   */
  certificate?: acm.ICertificate;

  constructor(scope: Construct, id: string, props: NextjsRouteProps) {
    super(scope, id);

    this.props = props;

    // Create Custom Domain
    this.validateCustomDomainSettings();

    // TODO: this is something we need to figure out how to pass to the distribution
    // build domainNames
    const domainNames = this.buildDistributionDomainNames();

    // Connect Custom Domain to CloudFront Distribution
    this.createRoute53Records();
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
