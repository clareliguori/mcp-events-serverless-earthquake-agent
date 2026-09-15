import * as cdk from "aws-cdk-lib";
import type * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as cr from "aws-cdk-lib/custom-resources";
import * as iam from "aws-cdk-lib/aws-iam";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53targets from "aws-cdk-lib/aws-route53-targets";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import {
  EDGE_AUTH_CONFIG_PARAMETER_NAME,
  resolveDomainName,
  type SharedProps,
} from "./shared-props.js";

export interface AuthStackProps extends cdk.StackProps, SharedProps {
  /**
   * The us-east-1 wildcard certificate created by DnsUsEast1Stack. Cognito
   * fronts custom Hosted UI domains with CloudFront and therefore requires the
   * certificate in us-east-1. This stack deploys to the target region, so the
   * certificate is passed across regions as a construct reference (Fn.importValue
   * cannot resolve across regions) using CDK's `crossRegionReferences`. This is
   * the documented cross-region exception to the named-export convention; the
   * subdomain zone id is still imported by name (same region).
   */
  readonly usEast1Certificate: acm.ICertificate;
}

/**
 * Authentication foundation for the MCP Events Serverless Agent sample.
 *
 * Responsibilities (Requirements 13.4, 13.5, 10.1):
 * - Create a Cognito User Pool with email sign-in. For this demo, self sign-up
 *   and account recovery are disabled, so an administrator provisions users out
 *   of band rather than the Hosted UI exposing sign-up and password reset.
 * - Create a public User Pool Client (no client secret) configured for the
 *   OAuth authorization code grant, which Cognito serves with PKCE for public
 *   single page apps.
 * - Attach a custom Hosted UI domain at `auth.<subdomain>.<parentDomain>`
 *   (for example `auth.earthquake-agent.liguori.people.aws.dev`) using the
 *   us-east-1 wildcard certificate, and point a Route53 alias record at it.
 *
 * Cross-stack wiring: the subdomain hosted zone id is imported from
 * DnsRegionalStack's export by name (same region) via Fn.importValue. The
 * us-east-1 certificate is consumed as a construct reference across regions
 * (see {@link AuthStackProps.usEast1Certificate}). The User Pool id, client id,
 * and Hosted UI domain are published via the CfnOutput exports below and
 * imported by name (DataApiStack, WebappStack).
 *
 * IMPORTANT: A Cognito custom domain requires its ACM certificate to live in
 * the us-east-1 Region (Cognito fronts custom domains with CloudFront), which
 * the injected us-east-1 certificate satisfies regardless of the target region.
 * Cognito also requires the parent domain `<subdomain>.<parentDomain>` to
 * resolve (have a DNS A record) before the custom domain can be created at
 * deploy time.
 */
export class AuthStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    const domainName = resolveDomainName(props);
    const authDomainName = `auth.${domainName}`;
    const appUrl = `https://app.${domainName}`;

    // User Pool: email-based sign-in. For this demo, self sign-up and account
    // recovery are disabled, so an administrator provisions users out of band
    // (for example via `aws cognito-idp admin-create-user`).
    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: "earthquake-agent-users",
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.NONE,
      // Demo sample: tear the pool down cleanly with the stack.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Public client for the SPA: no generated secret means Cognito requires
    // PKCE for the authorization code grant. Implicit grant is disabled.
    const client = userPool.addClient("WebappClient", {
      userPoolClientName: "earthquake-agent-webapp",
      generateSecret: false,
      authFlows: { userSrp: true },
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
          implicitCodeGrant: false,
        },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: [
          appUrl,
          `${appUrl}/`,
          // The CloudFront Lambda@Edge auth gate's own callback. The gate uses
          // this same public PKCE client (see WebappAuthEdgeStack), so it needs
          // its redirect URI registered here; the SPA's callbacks above are
          // unchanged.
          `${appUrl}/_auth/callback`,
          "http://localhost:5173/",
        ],
        logoutUrls: [appUrl, `${appUrl}/`, "http://localhost:5173/"],
      },
      preventUserExistenceErrors: true,
    });

    // The us-east-1 wildcard certificate is injected as a construct reference
    // (cross-region from DnsUsEast1Stack); Cognito requires it in us-east-1.
    const certificate = props.usEast1Certificate;

    // Custom Hosted UI domain at auth.<subdomain>.<parentDomain>.
    const userPoolDomain = userPool.addDomain("HostedUiDomain", {
      customDomain: {
        domainName: authDomainName,
        certificate,
      },
    });

    // Alias record so the Hosted UI domain resolves to the Cognito managed
    // CloudFront distribution. The subdomain zone id is imported by name from
    // DnsRegionalStack (same region).
    const subdomainZone = route53.HostedZone.fromHostedZoneAttributes(
      this,
      "SubdomainZone",
      {
        hostedZoneId: cdk.Fn.importValue("EarthquakeAgent-SubdomainZoneId"),
        zoneName: domainName,
      },
    );

    new route53.ARecord(this, "HostedUiAliasRecord", {
      zone: subdomainZone,
      recordName: authDomainName,
      target: route53.RecordTarget.fromAlias(
        new route53targets.UserPoolDomainTarget(userPoolDomain),
      ),
      comment: "Alias to the Cognito Hosted UI custom domain distribution",
    });

    new cdk.CfnOutput(this, "UserPoolId", {
      value: userPool.userPoolId,
      description: "Cognito User Pool id for the earthquake-agent sample",
      exportName: "EarthquakeAgent-UserPoolId",
    });

    new cdk.CfnOutput(this, "UserPoolClientId", {
      value: client.userPoolClientId,
      description:
        "Cognito User Pool Client id for the webapp (PKCE public client)",
      exportName: "EarthquakeAgent-UserPoolClientId",
    });

    new cdk.CfnOutput(this, "HostedUiDomain", {
      value: authDomainName,
      description:
        "Cognito Hosted UI custom domain (auth.earthquake-agent.<parentDomain>)",
      exportName: "EarthquakeAgent-HostedUiDomain",
    });

    // --- Runtime config for the CloudFront edge auth gate --------------------
    // The Lambda@Edge auth gate (WebappAuthEdgeStack) needs the User Pool id and
    // app client id at runtime, but Lambda@Edge supports no environment
    // variables and both values are CloudFormation tokens at synth time, so they
    // can be neither injected as env vars nor baked into its bundle. Publish
    // them here under a well-known literal parameter name that the gate reads
    // once per cold start.
    //
    // A plain (unencrypted) String parameter is correct: every field here is
    // already public to any browser that loads the SPA — the same values are
    // written into the site's `config.json` by WebappStack. Nothing secret
    // crosses this boundary.
    new ssm.StringParameter(this, "EdgeAuthConfigParameter", {
      parameterName: EDGE_AUTH_CONFIG_PARAMETER_NAME,
      description:
        "Non-secret Cognito configuration read by the webapp CloudFront Lambda@Edge auth gate",
      // toJsonString (not JSON.stringify) so the unresolved token values above
      // resolve correctly at deploy time.
      stringValue: this.toJsonString({
        userPoolId: userPool.userPoolId,
        clientId: client.userPoolClientId,
        hostedUiDomain: authDomainName,
        appDomain: `app.${domainName}`,
      }),
    });

    // --- Persistent test user (auto-synced password, no manual step) --------
    // Creates a Cognito user + a Secrets Manager secret with the generated
    // password, then uses an AwsCustomResource to call adminSetUserPassword at
    // deploy time so the password is immediately usable without a manual script.

    const testUsername = "test-user@example.com";

    new cognito.CfnUserPoolUser(this, "TestUser", {
      userPoolId: userPool.userPoolId,
      username: testUsername,
      userAttributes: [
        { name: "email", value: testUsername },
        { name: "email_verified", value: "true" },
      ],
      messageAction: "SUPPRESS",
    });

    const testUserSecret = new secretsmanager.Secret(this, "TestUserSecret", {
      secretName: "earthquake-agent-test-user",
      description:
        "Credentials for the persistent test user in the earthquake-agent Cognito pool",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: testUsername }),
        generateStringKey: "password",
        excludeCharacters: '"@/\\',
        includeSpace: false,
        passwordLength: 16,
        requireEachIncludedType: true,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Sync the generated password to Cognito as a permanent password at deploy
    // time. The physicalResourceId includes the secret version so a redeploy
    // after secret rotation triggers a new sync.
    const syncPassword = new cr.AwsCustomResource(
      this,
      "SyncTestUserPassword",
      {
        onCreate: {
          service: "CognitoIdentityServiceProvider",
          action: "adminSetUserPassword",
          parameters: {
            UserPoolId: userPool.userPoolId,
            Username: testUsername,
            Password: testUserSecret
              .secretValueFromJson("password")
              .unsafeUnwrap(),
            Permanent: true,
          },
          physicalResourceId: cr.PhysicalResourceId.of(
            "sync-test-user-password",
          ),
        },
        onUpdate: {
          service: "CognitoIdentityServiceProvider",
          action: "adminSetUserPassword",
          parameters: {
            UserPoolId: userPool.userPoolId,
            Username: testUsername,
            Password: testUserSecret
              .secretValueFromJson("password")
              .unsafeUnwrap(),
            Permanent: true,
          },
          physicalResourceId: cr.PhysicalResourceId.of(
            "sync-test-user-password",
          ),
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ["cognito-idp:AdminSetUserPassword"],
            resources: [userPool.userPoolArn],
          }),
        ]),
      },
    );

    // Ensure the user exists before we try to set its password.
    syncPassword.node.addDependency(
      this.node.findChild("TestUser") as cdk.CfnResource,
    );

    new cdk.CfnOutput(this, "TestUserSecretName", {
      value: testUserSecret.secretName,
      description:
        "Secrets Manager secret name containing test user credentials (username + password)",
      exportName: "EarthquakeAgent-TestUserSecretName",
    });
  }
}
