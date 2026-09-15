#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AgentStack } from "../lib/agent-stack.js";
import { AuthStack } from "../lib/auth-stack.js";
import { DataApiStack } from "../lib/data-api-stack.js";
import { DnsRegionalStack } from "../lib/dns-regional-stack.js";
import { DnsUsEast1Stack } from "../lib/dns-us-east-1-stack.js";
import { MonitoringStack } from "../lib/monitoring-stack.js";
import { SchedulerServerStack } from "../lib/scheduler-server-stack.js";
import { SubscriptionManagerStack } from "../lib/subscription-manager-stack.js";
import { UsgsServerStack } from "../lib/usgs-server-stack.js";
import { WebappAuthEdgeStack } from "../lib/webapp-auth-edge-stack.js";
import { WebappStack } from "../lib/webapp-stack.js";
import { WebhookReceiverStack } from "../lib/webhook-receiver-stack.js";
import {
  DEFAULT_PARENT_DOMAIN,
  DEFAULT_SUBDOMAIN,
  type SharedProps,
} from "../lib/shared-props.js";

const app = new cdk.App();

// Shared configuration for every stack. `parentDomain` can be overridden at
// synth/deploy time with `-c parentDomain=example.com`.
const shared: SharedProps = {
  parentDomain:
    (app.node.tryGetContext("parentDomain") as string | undefined) ??
    DEFAULT_PARENT_DOMAIN,
  subdomain:
    (app.node.tryGetContext("subdomain") as string | undefined) ??
    DEFAULT_SUBDOMAIN,
};

// The application's target region, resolved from the standard CDK environment
// variables populated by the CLI. Every stack except DnsUsEast1Stack deploys
// here. Route53 HostedZone.fromLookup (in DnsRegionalStack) requires a concrete
// account and region at synth time, which this provides.
const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

// CloudFront (Webapp) and Cognito (Auth) custom-domain certificates MUST live
// in us-east-1 regardless of the target region, so the us-east-1 certificate
// stack is pinned to us-east-1 explicitly. The account still comes from the
// CLI-provided environment.
const usEast1Env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: "us-east-1",
};

// --- DNS / TLS foundation (split by region) --------------------------------
// DnsRegionalStack (target region) owns the subdomain hosted zone, the NS
// delegation from the parent zone, and the REGIONAL wildcard certificate used
// by the four REGIONAL API Gateway custom domains (Data API, USGS, Scheduler,
// Webhook Receiver). Same-region consumers import the zone id and regional
// certificate ARN by their export names via Fn.importValue.
const dnsRegional = new DnsRegionalStack(app, "DnsRegionalStack", {
  ...shared,
  env,
  // The subdomain zone is shared across regions with DnsUsEast1Stack (which
  // validates its us-east-1 certificate against it). Fn.importValue cannot
  // cross regions, so CDK provisions the cross-region reader resources.
  crossRegionReferences: true,
});

// DnsUsEast1Stack (always us-east-1) owns the us-east-1 wildcard certificate
// used by the Webapp CloudFront distribution and the Cognito Hosted UI custom
// domain. It validates that certificate against the subdomain zone from
// DnsRegionalStack, passed across regions as a construct reference because
// Fn.importValue cannot resolve across regions.
const dnsUsEast1 = new DnsUsEast1Stack(app, "DnsUsEast1Stack", {
  ...shared,
  env: usEast1Env,
  subdomainZone: dnsRegional.subdomainZone,
  crossRegionReferences: true,
});

// AuthStack (Cognito User Pool + custom Hosted UI domain) imports the subdomain
// zone id from DnsRegionalStack via Fn.importValue (same region) and consumes
// the us-east-1 certificate from DnsUsEast1Stack across regions (construct
// reference + crossRegionReferences). The Cognito custom Hosted UI domain
// requires its certificate in us-east-1, which that certificate satisfies.
const auth = new AuthStack(app, "AuthStack", {
  ...shared,
  env,
  usEast1Certificate: dnsUsEast1.certificate,
  crossRegionReferences: true,
});

// DataApiStack (API Gateway + Lambda for config, subscriptions, reports, and
// the read-only session messages endpoint) imports the REGIONAL wildcard
// certificate and subdomain zone from DnsRegionalStack, the Cognito User Pool
// id from AuthStack, and the sessions bucket ARN from AgentStack, all via
// Fn.importValue. AgentStack MUST export its sessions bucket ARN under the
// export name `EarthquakeAgent-SessionsBucketArn` for the read-only
// s3:GetObject grant to resolve at deploy time.
const dataApi = new DataApiStack(app, "DataApiStack", { ...shared, env });

// UsgsServerStack (MCP Server 1 - USGS Earthquake Feed) and SchedulerServerStack
// (MCP Server 2 - Message Scheduler) each expose an IAM-authorized REGIONAL API
// Gateway custom domain (usgs-mcp/scheduler-mcp.earthquake-agent.<parentDomain>)
// for the MCP HTTP transport, a dual-trigger Lambda (API Gateway + an
// EventBridge poll schedule), DynamoDB tables, and a dedicated KMS key for the
// per-subscription webhook secret. They import the REGIONAL wildcard
// certificate and subdomain zone from DnsRegionalStack via Fn.importValue.
const usgsServer = new UsgsServerStack(app, "UsgsServerStack", {
  ...shared,
  env,
});
const schedulerServer = new SchedulerServerStack(app, "SchedulerServerStack", {
  ...shared,
  env,
});

// WebhookReceiverStack (open REGIONAL API Gateway custom domain
// webhook.earthquake-agent.<parentDomain> + SQS event queue, DLQ, and a
// CloudWatch alarm on DLQ depth) owns the webhook delivery endpoint both MCP
// servers target. It imports the REGIONAL wildcard certificate and subdomain
// zone from DnsRegionalStack. It exports the SQS queue ARN consumed by
// AgentStack.
const webhookReceiver = new WebhookReceiverStack(app, "WebhookReceiverStack", {
  ...shared,
  env,
});

// AgentStack (Serverless Strands Agent Lambda triggered by the Webhook
// Receiver SQS queue with batch size 1, an S3 sessions bucket, and a DynamoDB
// session locks table) imports the webhook queue ARN from WebhookReceiverStack
// and exports its sessions bucket ARN under EarthquakeAgent-SessionsBucketArn,
// which DataApiStack imports for read-only session access.
const agent = new AgentStack(app, "AgentStack", { ...shared, env });

// SubscriptionManagerStack (Lambda with dual triggers: the CustomerConfig
// DynamoDB Stream from DataApiStack plus an EventBridge refresh schedule)
// imports the CustomerConfig stream ARN from DataApiStack and holds an
// execute-api:Invoke role for the MCP server API Gateways and the Data API.
const subscriptionManager = new SubscriptionManagerStack(
  app,
  "SubscriptionManagerStack",
  {
    ...shared,
    env,
  },
);

// WebappAuthEdgeStack (the CloudFront viewer-request Cognito auth gate) is
// pinned to us-east-1 like DnsUsEast1Stack, because Lambda@Edge functions must
// live there. It needs the APP region as a concrete string — the region of the
// SSM parameter AuthStack publishes its Cognito config into — because
// Lambda@Edge supports no environment variables and the value has to be baked
// into the function bundle at synth time.
const webappAuthEdge = new WebappAuthEdgeStack(app, "WebappAuthEdgeStack", {
  env: usEast1Env,
  appRegion: env.region ?? "",
  crossRegionReferences: true,
});

// WebappStack (S3 SPA bucket fronted by a CloudFront distribution at
// app.earthquake-agent.<parentDomain> using Origin Access Control, with a
// security response headers policy) imports the subdomain zone id from
// DnsRegionalStack via Fn.importValue (same region) and consumes the us-east-1
// certificate from DnsUsEast1Stack across regions (construct reference +
// crossRegionReferences). CloudFront requires its certificate in us-east-1,
// which that certificate satisfies. The Lambda@Edge auth gate version comes
// across regions the same way, for the same reason.
const webapp = new WebappStack(app, "WebappStack", {
  ...shared,
  env,
  usEast1Certificate: dnsUsEast1.certificate,
  authGateFunctionVersion: webappAuthEdge.functionVersion,
  crossRegionReferences: true,
});

// --- Explicit deploy ordering for Fn.importValue relationships -------------
// This app shares values across stacks exclusively via named CfnOutput exports
// and `Fn.importValue` (rather than passing construct references), which keeps
// the cross-stack contract explicit but means CDK cannot infer deploy order
// from those string-based imports. Declare each import relationship as a stack
// dependency so `cdk deploy --all` creates exporters before importers. (The
// cross-region construct references — DnsUsEast1 -> DnsRegional, Auth/Webapp ->
// DnsUsEast1 — already add their own implicit dependencies.)
dnsUsEast1.addDependency(dnsRegional); // subdomain zone (cross-region construct ref)
auth.addDependency(dnsRegional); // EarthquakeAgent-SubdomainZoneId
usgsServer.addDependency(dnsRegional); // cert ARN + subdomain zone id
schedulerServer.addDependency(dnsRegional); // cert ARN + subdomain zone id
webhookReceiver.addDependency(dnsRegional); // cert ARN + subdomain zone id
webapp.addDependency(dnsRegional); // EarthquakeAgent-SubdomainZoneId
// The auth gate reads AuthStack's edge-config SSM parameter at RUNTIME rather
// than importing it, so nothing in CloudFormation orders these two. Declare it
// explicitly: if the gate went live before the parameter existed, every request
// to the site would fail closed with a 500.
webappAuthEdge.addDependency(auth); // /earthquake-agent/auth/edge-config
agent.addDependency(webhookReceiver); // EarthquakeAgent-WebhookQueueArn
dataApi.addDependency(dnsRegional); // cert ARN + subdomain zone id
dataApi.addDependency(auth); // EarthquakeAgent-UserPoolId
dataApi.addDependency(agent); // EarthquakeAgent-SessionsBucketArn
subscriptionManager.addDependency(dataApi); // CustomerConfig table + stream ARNs

// MonitoringStack (composite alarm that aggregates all component alarms into a
// single system health indicator). Depends on every stack that creates alarms
// so the child alarms exist before the composite alarm references them.
const monitoring = new MonitoringStack(app, "MonitoringStack", { env });
monitoring.addDependency(agent);
monitoring.addDependency(dataApi);
monitoring.addDependency(webhookReceiver);
monitoring.addDependency(subscriptionManager);
monitoring.addDependency(usgsServer);
monitoring.addDependency(schedulerServer);

app.synth();
