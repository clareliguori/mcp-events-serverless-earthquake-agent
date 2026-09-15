import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import type * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";
import { resolveDomainName, type SharedProps } from "./shared-props.js";

export interface WebappStackProps extends cdk.StackProps, SharedProps {
  /**
   * The us-east-1 wildcard certificate created by DnsUsEast1Stack. CloudFront
   * requires its certificate in us-east-1. This stack deploys to the target
   * region, so the certificate is passed across regions as a construct
   * reference (Fn.importValue cannot resolve across regions) using CDK's
   * `crossRegionReferences`. This is the documented cross-region exception to
   * the named-export convention; the subdomain zone id is still imported by
   * name (same region).
   */
  readonly usEast1Certificate: acm.ICertificate;

  /**
   * The published Lambda@Edge version from WebappAuthEdgeStack, attached to the
   * default behavior as a VIEWER_REQUEST trigger so no request reaches the
   * origin without a valid Cognito session.
   *
   * Like the certificate, this is a us-east-1 resource consumed by a stack in
   * the target region, so it crosses regions as a construct reference (see
   * {@link usEast1Certificate}).
   */
  readonly authGateFunctionVersion: lambda.IVersion;
}

/**
 * Webapp stack for the MCP Events Serverless Agent sample.
 *
 * Responsibilities (Requirements 10.1, 13.4, 13.5, 17.4):
 * - A private S3 bucket that stores the built SvelteKit SPA assets. Block all
 *   public access, S3-managed encryption, and SSL enforcement; demo buckets are
 *   torn down with the stack.
 * - A CloudFront distribution at the custom domain
 *   `app.<subdomain>.<parentDomain>` (for example
 *   `app.earthquake-agent.liguori.people.aws.dev`) fronting the bucket via
 *   Origin Access Control so the bucket is never publicly reachable
 *   (Requirement 17.4).
 * - SPA routing: `index.html` as the default root object and 403/404 responses
 *   rewritten to `/index.html` with a 200 so client-side routing works on deep
 *   links.
 * - A response headers policy applying sensible security headers (HSTS,
 *   X-Content-Type-Options, X-Frame-Options, Referrer-Policy).
 * - A Route53 alias record pointing the custom domain at the distribution.
 *
 * AUTH GATE (Requirement 17.4): the default behavior carries a VIEWER_REQUEST
 * Lambda@Edge trigger (see WebappAuthEdgeStack) that requires a valid Cognito
 * session before any request reaches the origin. Without it the SPA's own
 * client-side login could only start AFTER the bundle had been served, leaving
 * the landing page and every asset anonymously fetchable. Consequences worth
 * knowing:
 * - The SPA keeps its own in-memory PKCE flow untouched (Requirement 10.6).
 * - Signing in is therefore TWO steps, verified against the deployed site: the
 *   Hosted UI form (the gate), then the SPA's own "Sign in" button, which
 *   completes silently with no second form because the viewer already holds a
 *   Cognito session. The SPA does not auto-initiate its login
 *   (`handleRedirectCallback` simply reports "unauthenticated" when no `code` is
 *   present), so the landing page IS still shown to a gated viewer — it is not
 *   dead code. Making that click disappear would take a webapp change.
 * - The 403/404 -> `index.html` rewrites below are unaffected: they are origin
 *   responses, and the gate does not re-run for them.
 *
 * OAC NOTE (Requirement 17.4): The S3 origin is created with
 * `origins.S3BucketOrigin.withOriginAccessControl(bucket)`, the current
 * (aws-cdk-lib 2.230) OAC-based origin. It auto-creates an Origin Access
 * Control and wires the bucket policy so only this distribution can read the
 * bucket, preventing direct S3 access. The deprecated
 * `S3Origin` + `OriginAccessIdentity` pattern is intentionally avoided.
 *
 * CERTIFICATE NOTE: CloudFront requires its ACM certificate to live in
 * us-east-1. The us-east-1 wildcard certificate created by DnsUsEast1Stack is
 * injected as a construct reference across regions (see
 * {@link WebappStackProps.usEast1Certificate}), so this stack can deploy to any
 * target region while satisfying that constraint. The subdomain zone id is
 * imported by name from DnsRegionalStack (same region).
 *
 * ASSET DEPLOYMENT (Requirement 10.1): The built SvelteKit SPA
 * (`packages/webapp/build`, produced by `npm run build -w @mcp-events/webapp`)
 * is published into the site bucket by an `s3deploy.BucketDeployment`, which
 * also invalidates the CloudFront distribution so a redeploy serves fresh
 * assets immediately. The webapp loads its runtime configuration from
 * `config.json` at the site root (see the webapp's `$lib/auth/config`), so this
 * stack OVERWRITES that file at deploy time with the real Cognito and Data API
 * values via a second inline `BucketDeployment` source. This keeps the built
 * artifact environment agnostic (the committed `config.json` carries only local
 * dev placeholders) while the deployed site gets the correct values:
 * - `clientId` is imported by name from AuthStack
 *   (`EarthquakeAgent-UserPoolClientId`).
 * - `hostedUiDomain` and `apiBaseUrl` are deterministic from the shared domain
 *   (`auth.`/`api.<subdomain>.<parentDomain>`), so they are recomputed here
 *   rather than imported, avoiding synth-time stack ordering dependencies.
 */
export class WebappStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WebappStackProps) {
    super(scope, id, props);

    const domainName = resolveDomainName(props);
    const appDomainName = `app.${domainName}`;

    // --- S3: SPA asset bucket (private, OAC-only access) ---------------------
    const siteBucket = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Demo sample: remove the bucket and its contents with the stack.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // --- Security response headers -------------------------------------------
    const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(
      this,
      "SecurityHeadersPolicy",
      {
        responseHeadersPolicyName: "earthquake-agent-webapp-security-headers",
        comment: "Security headers for the earthquake-agent webapp SPA",
        securityHeadersBehavior: {
          strictTransportSecurity: {
            accessControlMaxAge: cdk.Duration.days(365),
            includeSubdomains: true,
            preload: true,
            override: true,
          },
          contentTypeOptions: { override: true },
          frameOptions: {
            frameOption: cloudfront.HeadersFrameOption.DENY,
            override: true,
          },
          referrerPolicy: {
            referrerPolicy:
              cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
            override: true,
          },
        },
      },
    );

    // --- us-east-1 wildcard certificate (cross-region construct reference) ---
    // CloudFront requires its certificate in us-east-1; it is injected from
    // DnsUsEast1Stack across regions.
    const certificate = props.usEast1Certificate;

    // --- CloudFront distribution (OAC origin) --------------------------------
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: "earthquake-agent webapp SPA distribution",
      domainNames: [appDomainName],
      certificate,
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy,
        // Cognito auth gate (Requirement 17.4). VIEWER_REQUEST, not
        // ORIGIN_REQUEST: an origin trigger is skipped on a cache hit, so a
        // cached landing page would still be served anonymously. A viewer
        // trigger runs on every request, ahead of the cache lookup.
        //
        // The session cookie is deliberately NOT part of the cache key
        // (CACHING_OPTIMIZED strips cookies). That is correct here: these are
        // static assets, identical for every signed-in viewer, and the
        // authorization decision is made per request by the gate before the
        // cache is consulted.
        edgeLambdas: [
          {
            functionVersion: props.authGateFunctionVersion,
            eventType: cloudfront.LambdaEdgeEventType.VIEWER_REQUEST,
          },
        ],
      },
      // SPA deep-link support: serve index.html (200) for client-routed paths
      // that S3 reports as 403/404.
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: cdk.Duration.minutes(5),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: cdk.Duration.minutes(5),
        },
      ],
    });

    // --- Route53 alias to the distribution -----------------------------------
    const subdomainZone = route53.HostedZone.fromHostedZoneAttributes(
      this,
      "SubdomainZone",
      {
        hostedZoneId: cdk.Fn.importValue("EarthquakeAgent-SubdomainZoneId"),
        zoneName: domainName,
      },
    );

    new route53.ARecord(this, "WebappAliasRecord", {
      zone: subdomainZone,
      recordName: appDomainName,
      target: route53.RecordTarget.fromAlias(
        new route53targets.CloudFrontTarget(distribution),
      ),
      comment:
        "Alias to the webapp CloudFront distribution (app.earthquake-agent.*)",
    });

    // --- SPA asset deployment + runtime config injection ---------------------
    // Publish the built SvelteKit SPA into the bucket and invalidate the
    // distribution. The build output lives at packages/webapp/build; this stack
    // compiles to packages/cdk/dist/lib, so walk up to the repo's packages/
    // directory. `npm run build -w @mcp-events/webapp` must run before deploy.
    const webappBuildDir = path.join(
      __dirname,
      "..",
      "..",
      "..",
      "webapp",
      "build",
    );

    // The webapp loads runtime config from `config.json` at the site root. The
    // built artifact carries only dev placeholders, so overwrite it at deploy
    // time with the real values. clientId is imported by name from AuthStack;
    // the hosted UI domain and API base URL are deterministic from the shared
    // domain (recomputed here to avoid synth-time stack ordering deps).
    const userPoolClientId = cdk.Fn.importValue(
      "EarthquakeAgent-UserPoolClientId",
    );
    const runtimeConfig = {
      cognito: {
        hostedUiDomain: `auth.${domainName}`,
        clientId: userPoolClientId,
        scopes: ["openid", "email", "profile"],
      },
      apiBaseUrl: `https://api.${domainName}`,
    };

    new s3deploy.BucketDeployment(this, "DeployWebapp", {
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ["/*"],
      sources: [
        // The built SPA assets.
        s3deploy.Source.asset(webappBuildDir),
        // Overwrite config.json with the deploy-time values. clientId is an
        // unresolved CloudFormation token, so use jsonData (the BucketDeployment
        // resolves the token at deploy time) rather than a static file.
        s3deploy.Source.jsonData("config.json", runtimeConfig),
      ],
    });

    // --- Cross-stack exports --------------------------------------------------
    new cdk.CfnOutput(this, "WebappCustomDomainUrl", {
      value: `https://${appDomainName}`,
      description: "Custom domain URL of the webapp SPA",
      exportName: "EarthquakeAgent-WebappCustomDomainUrl",
    });

    new cdk.CfnOutput(this, "WebappDistributionDomainName", {
      value: distribution.distributionDomainName,
      description: "CloudFront distribution domain name for the webapp SPA",
      exportName: "EarthquakeAgent-WebappDistributionDomainName",
    });

    new cdk.CfnOutput(this, "WebappBucketName", {
      value: siteBucket.bucketName,
      description: "Name of the S3 bucket that stores the webapp SPA assets",
      exportName: "EarthquakeAgent-WebappBucketName",
    });
  }
}
