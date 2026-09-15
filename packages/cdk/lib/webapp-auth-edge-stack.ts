import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";
import { EDGE_AUTH_CONFIG_PARAMETER_NAME } from "./shared-props.js";

export interface WebappAuthEdgeStackProps extends cdk.StackProps {
  /**
   * The APP region — where AuthStack publishes the edge auth config parameter.
   * This stack is pinned to us-east-1, so it cannot read its own `region`.
   *
   * MUST be a concrete region string (not a CloudFormation token): it is baked
   * into the function bundle at synth time, because Lambda@Edge cannot receive
   * it as an environment variable.
   */
  readonly appRegion: string;
}

/**
 * The CloudFront viewer-request Cognito auth gate for the webapp distribution.
 *
 * This stack is ALWAYS pinned to us-east-1 (see bin/app.ts), because Lambda@Edge
 * requires its function to live there regardless of where the rest of the
 * application deploys — the same constraint that gives us DnsUsEast1Stack.
 *
 * WHY THIS STACK EXISTS: without it, the webapp's S3 objects are served to
 * anyone who asks. Authentication only began after the SPA had already been
 * delivered, which left the landing page, the JS bundle, and `config.json`
 * anonymously reachable. The gate moves the authentication boundary in front of
 * the distribution: an unauthenticated request is redirected to the Cognito
 * Hosted UI and never reaches the origin. See the handler in
 * `@mcp-events/webapp-auth-edge` for the flow.
 *
 * WHY NOT `cloudfront.experimental.EdgeFunction`: that construct takes plain
 * `lambda.FunctionProps` and so cannot bundle TypeScript, and when used from a
 * non-us-east-1 stack it silently synthesizes an extra `edge-lambda-stack-*`
 * support stack. An explicit us-east-1 stack with `NodejsFunction` keeps the
 * esbuild pipeline every other Lambda in this repo uses and keeps the stack list
 * honest.
 *
 * CROSS-REGION WIRING: WebappStack deploys to the target region but must attach
 * this us-east-1 function version to its distribution. `Fn.importValue` cannot
 * resolve across regions, so the version is exposed as a public property and
 * consumed as a construct reference with `crossRegionReferences: true` on both
 * stacks — the same documented exception that carries the us-east-1 certificate
 * out of DnsUsEast1Stack. Attaching it is also what grants the function's role
 * the `edgelambda.amazonaws.com` trust: CDK's `CacheBehavior` adds that
 * statement itself when it is handed a real Version construct, so this stack
 * deliberately does not add it (doing both duplicates the statement).
 *
 * NO ENVIRONMENT VARIABLES: Lambda@Edge does not support them. The two values
 * the handler needs at runtime (User Pool id and app client id) are
 * CloudFormation tokens, so they are published by AuthStack into
 * {@link EDGE_AUTH_CONFIG_PARAMETER_NAME} and read once per cold start. The
 * parameter's NAME and REGION are known at synth time, so those two are injected
 * into the bundle with esbuild `define` — the one channel that survives the
 * no-env-vars restriction.
 *
 * LOG LOCATION: Lambda@Edge writes logs to the AWS Region CLOSEST TO THE VIEWER,
 * in log groups named `/aws/lambda/us-east-1.<functionName>`, not to a single
 * group in this stack's region. Do not expect this function's errors to appear
 * alongside the other components' logs, and note that MonitoringStack's
 * log-based metric filters do not observe them.
 */
export class WebappAuthEdgeStack extends cdk.Stack {
  /**
   * The published function version to attach as a viewer-request trigger.
   * Consumed cross-region by WebappStack (see the CROSS-REGION WIRING note).
   *
   * Lambda@Edge requires a numbered version; `$LATEST` and aliases are rejected.
   */
  public readonly functionVersion: lambda.IVersion;

  constructor(scope: Construct, id: string, props: WebappAuthEdgeStackProps) {
    super(scope, id, props);

    if (!props.appRegion || cdk.Token.isUnresolved(props.appRegion)) {
      throw new Error(
        "WebappAuthEdgeStack requires a concrete appRegion: it is baked into the Lambda@Edge bundle at synth time. Set CDK_DEFAULT_REGION (or pass --region) so the app region resolves.",
      );
    }

    // Compiled stack lives at packages/cdk/dist/lib, so walk up to the repo's
    // packages/ directory for the handler source and to the repo root for the
    // workspace lock file (same pattern as the other stacks).
    const packageRoot = path.join(
      __dirname,
      "..",
      "..",
      "..",
      "webapp-auth-edge",
    );

    const authGate = new NodejsFunction(this, "WebappAuthGate", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(packageRoot, "src", "handler.ts"),
      handler: "handler",
      // Runs on every viewer request, so it is cold-start sensitive: 256 MB buys
      // noticeably faster module init than the 128 MB floor for a fraction of a
      // cent at demo traffic.
      memorySize: 256,
      // Lambda@Edge allows up to 30s; a gate that needs more than 5s has failed
      // in a way the viewer should not be made to wait out. A cold start does an
      // SSM read plus a JWKS fetch and still lands comfortably inside this.
      timeout: cdk.Duration.seconds(5),
      // NOTE: no `environment` — Lambda@Edge rejects environment variables.
      // NOTE: no `logRetention` — the real log groups are per-viewer-region and
      // are not the group a retention custom resource here would target.
      depsLockFilePath: path.join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "package-lock.json",
      ),
      bundling: {
        // Lambda@Edge must be self-contained: bundle EVERYTHING. CDK's default
        // leaves `@aws-sdk/*` external on the assumption that the Lambda runtime
        // supplies it, which is not a guarantee worth relying on at the edge —
        // an unresolvable require here fails every request to the site. The
        // handler avoids `@aws-sdk/*` entirely, and this keeps it that way.
        externalModules: [],
        // The only supported channel for synth-time configuration, given that
        // env vars are unavailable. esbuild replaces these reads with literals;
        // outside the bundle they fall back to real env vars, which keeps the
        // handler runnable and testable.
        define: {
          "process.env.EQA_EDGE_CONFIG_PARAM": JSON.stringify(
            EDGE_AUTH_CONFIG_PARAMETER_NAME,
          ),
          "process.env.EQA_EDGE_CONFIG_REGION": JSON.stringify(props.appRegion),
        },
        minify: true,
      },
    });

    // Read the (non-secret) Cognito config parameter AuthStack publishes in the
    // app region. Scoped to the one parameter this function needs.
    authGate.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          cdk.Arn.format(
            {
              service: "ssm",
              region: props.appRegion,
              resource: "parameter",
              // Parameter names begin with "/" and the ARN must not double it.
              resourceName: EDGE_AUTH_CONFIG_PARAMETER_NAME.replace(/^\//, ""),
            },
            this,
          ),
        ],
      }),
    );

    this.functionVersion = authGate.currentVersion;

    new cdk.CfnOutput(this, "WebappAuthGateVersionArn", {
      value: authGate.currentVersion.edgeArn,
      description:
        "Version ARN of the webapp CloudFront viewer-request Cognito auth gate",
    });
  }
}
