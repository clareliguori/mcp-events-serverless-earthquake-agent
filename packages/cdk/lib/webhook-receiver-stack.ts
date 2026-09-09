import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as iam from "aws-cdk-lib/aws-iam";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53targets from "aws-cdk-lib/aws-route53-targets";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import { addApiGatewayAlarms, addLambdaAlarms, addLogErrorAlarm } from "./alarms.js";
import { resolveDomainName, type SharedProps } from "./shared-props.js";

export type WebhookReceiverStackProps = cdk.StackProps & SharedProps;

/**
 * Webhook Receiver stack for the MCP Events Serverless Agent sample.
 *
 * Responsibilities (Requirements 3.x, 13.4, 13.5, 17.1, 18.2, 19.2, 19.5):
 * - API Gateway REST API at the custom domain
 *   `webhook.<subdomain>.<parentDomain>` (for example
 *   `webhook.earthquake-agent.liguori.people.aws.dev`). Both MCP servers
 *   already hardcode this URL as their delivery target, so this stack only
 *   needs to own the domain.
 * - A Lambda proxy that validates the incoming Standard Webhooks HMAC-SHA256
 *   signature and enqueues the event to SQS with the `X-MCP-Subscription-Id`
 *   value as a message attribute (Requirements 3.1, 3.4).
 * - A FIFO SQS queue (message group = `customerId`) with a redrive policy to a
 *   FIFO dead-letter queue. Grouping by customer serializes one customer's
 *   events — which the agent's per-customer session lock requires — while
 *   different customers still process concurrently (Requirement 19.5), and
 *   failed events land in the DLQ after the retry budget is exhausted
 *   (Requirement 15.2).
 * - A CloudWatch alarm on the DLQ depth so operators are notified when messages
 *   accumulate (Requirement 18.2).
 *
 * AUTHORIZATION NOTE: The webhook endpoint is intentionally open (no IAM or
 * Cognito authorizer). MCP servers authenticate each delivery with a Standard
 * Webhooks HMAC-SHA256 signature rather than IAM. Per the MCP Events extension,
 * the signing secret is client-supplied per subscription, so the Lambda handler
 * (subtask 5.4) does NOT hold per-server secrets. Instead, for each delivery it
 * reads the `X-MCP-Subscription-Id` header and looks up that subscription's
 * secret via the Data API (`GET /subscriptions/{subscriptionId}`, IAM SigV4
 * signed), which returns the **plaintext** `whsec_` value (the Data API
 * decrypts it at its storage boundary). The receiver then validates the
 * Standard Webhooks signature against the per-subscription secret before
 * enqueueing anything (Requirements 3.1, 17.1, 17.9). The Webhook Receiver
 * holds **no KMS permissions** and performs no KMS operations itself. The
 * per-delivery lookup is well within the latency budget (Requirement 19.2).
 *
 * Cross-stack wiring follows the design's CfnOutput / Fn.importValue approach
 * (same pattern as DataApiStack) so this stack stays environment agnostic:
 * imports the wildcard certificate ARN and subdomain hosted zone from DnsStack.
 * The Data API custom-domain URL is deterministic, so it is passed as an
 * environment variable rather than a cross-stack import to avoid a synth-time
 * ordering dependency (same approach the MCP server stacks use for the webhook
 * URL). The queue ARN/URL are exported so AgentStack (which owns the agent
 * Lambda) can attach the queue as its SQS event source.
 *
 * HANDLER NOTE: The Lambda handler lives in the @mcp-events/webhook-receiver
 * package at src/handler.ts (subtask 5.4). The NodejsFunction `entry` points at
 * it directly.
 */
export class WebhookReceiverStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WebhookReceiverStackProps) {
    super(scope, id, props);

    const domainName = resolveDomainName(props);
    const webhookDomainName = `webhook.${domainName}`;
    // The Data API lives at a deterministic custom domain created by
    // DataApiStack. The handler resolves each delivery's per-subscription secret
    // by calling GET /subscriptions/{subscriptionId} with IAM SigV4; pass the
    // URL as an environment variable rather than a cross-stack import to avoid a
    // synth-time ordering dependency.
    const dataApiUrl = `https://api.${domainName}`;

    // --- SQS: dead-letter queue + main event queue --------------------------
    // FIFO queues. Each delivery is enqueued under `MessageGroupId =
    // customerId` (see the handler), which makes SQS serialize a single
    // customer's events while still processing different customers concurrently
    // — Lambda caps FIFO concurrency at the number of active message groups, so
    // cross-customer parallelism is preserved (Requirement 19.5). That
    // serialization is what the agent's per-customer session lock needs: with a
    // standard queue, two events for the same customer are delivered
    // concurrently, race for the lock, and the loser fails its receive.
    //
    // A FIFO queue's dead-letter queue must also be FIFO. Failed events move to
    // the DLQ after maxReceiveCount delivery attempts (Requirement 15.2: up to
    // 3 attempts).
    //
    // NOTE (FIFO ordering tradeoff): while a message is being retried it blocks
    // its own message group, so a repeatedly-failing event delays that one
    // customer's later events until it dead-letters. That is the intended
    // behaviour for an ordered accumulator, and it is bounded by
    // maxReceiveCount x visibilityTimeout.
    const deadLetterQueue = new sqs.Queue(this, "EventDeadLetterQueue", {
      // Explicit name: a FIFO queue name must end in `.fifo`, so name both
      // queues deterministically rather than relying on generated names.
      queueName: "earthquake-agent-events-dlq.fifo",
      fifo: true,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });

    const eventQueue = new sqs.Queue(this, "EventQueue", {
      queueName: "earthquake-agent-events.fifo",
      fifo: true,
      // The handler supplies an explicit MessageDeduplicationId (the event id)
      // when the payload carries one; content-based deduplication is the
      // fallback for a payload without a usable id.
      contentBasedDeduplication: true,
      enforceSSL: true,
      // The agent invokes the LLM per message, so give consumers ample time
      // before a message becomes visible again for retry.
      visibilityTimeout: cdk.Duration.seconds(300),
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: {
        queue: deadLetterQueue,
        maxReceiveCount: 3,
      },
    });

    // --- CloudWatch alarm on DLQ depth (Requirement 18.2) -------------------
    // Fire as soon as a single message lands in the DLQ; missing data (an empty
    // DLQ reports no datapoints) is treated as not breaching.
    new cloudwatch.Alarm(this, "DlqDepthAlarm", {
      alarmName: "earthquake-agent-webhook-dlq-depth",
      alarmDescription:
        "Alarms when messages accumulate in the Webhook Receiver dead-letter queue",
      metric: deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
        statistic: "Maximum",
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // --- SSM SecureString secrets for signature validation ------------------
    // (Removed.) Per the MCP Events extension the signing secret is
    // client-supplied per subscription, so there are no per-server SSM secrets.
    // The handler resolves each delivery's secret at runtime via the Data API
    // (see the AUTHORIZATION NOTE above).

    // --- Lambda handler -------------------------------------------------------
    // Compiled stack lives at packages/cdk/dist/lib, so walk up to the repo's
    // packages/ directory to reach the webhook-receiver source and up to the
    // repo root for the workspace lock file (same pattern as DataApiStack).
    const webhookReceiverPackageRoot = path.join(
      __dirname,
      "..",
      "..",
      "..",
      "webhook-receiver",
    );
    const handlerFn = new NodejsFunction(this, "WebhookReceiverHandler", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(webhookReceiverPackageRoot, "src", "handler.ts"),
      handler: "handler",
      memorySize: 256,
      // Signature validation plus an SQS enqueue must finish well within the
      // webhook timeout (Requirement 19.2: under 100 ms of useful work), but
      // keep a safety margin for cold starts.
      timeout: cdk.Duration.seconds(10),
      depsLockFilePath: path.join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "package-lock.json",
      ),
      environment: {
        EVENT_QUEUE_URL: eventQueue.queueUrl,
        DATA_API_URL: dataApiUrl,
      },
    });

    // --- IAM grants (least privilege) ----------------------------------------
    eventQueue.grantSendMessages(handlerFn);

    // execute-api:Invoke on the Data API so the handler can resolve each
    // delivery's per-subscription secret via GET /subscriptions/{subscriptionId}
    // with IAM SigV4. DataApiStack is created separately and does not export its
    // API id, so scope the grant to this account/region's execute-api namespace
    // (same approach as DataApiStack, AgentStack, and SubscriptionManagerStack).
    // The Data API returns the plaintext whsec_ (it decrypts at its storage
    // boundary), so the Webhook Receiver holds NO KMS permissions (Requirement
    // 17.9).
    handlerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["execute-api:Invoke"],
        resources: [
          cdk.Stack.of(this).formatArn({
            service: "execute-api",
            resource: "*",
            arnFormat: cdk.ArnFormat.NO_RESOURCE_NAME,
          }),
        ],
      }),
    );

    // --- API Gateway custom domain + REST API (open endpoint) ----------------
    const certificate = acm.Certificate.fromCertificateArn(
      this,
      "WildcardCertificate",
      cdk.Fn.importValue("EarthquakeAgent-RegionalWildcardCertificateArn"),
    );

    const api = new apigateway.RestApi(this, "WebhookApi", {
      restApiName: "earthquake-agent-webhook-receiver",
      description:
        "Webhook Receiver HTTP endpoint for the MCP Events Serverless Agent sample (Standard Webhooks signature validated in the handler)",
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      domainName: {
        domainName: webhookDomainName,
        certificate,
        endpointType: apigateway.EndpointType.REGIONAL,
        securityPolicy: apigateway.SecurityPolicy.TLS_1_2,
      },
      deployOptions: {
        stageName: "prod",
      },
    });

    const integration = new apigateway.LambdaIntegration(handlerFn);

    // The endpoint is open (AuthorizationType.NONE): authenticity is enforced
    // by the Standard Webhooks signature the handler validates, not by IAM. A
    // greedy `{proxy+}` ANY route plus `/webhook` (POST) lets the MCP servers
    // post deliveries to the documented path.
    const noAuth: apigateway.MethodOptions = {
      authorizationType: apigateway.AuthorizationType.NONE,
    };

    const webhook = api.root.addResource("webhook");
    webhook.addMethod("POST", integration, noAuth);

    const proxy = api.root.addResource("{proxy+}");
    proxy.addMethod("ANY", integration, noAuth);

    // --- Route53 alias to the API custom domain ------------------------------
    const subdomainZone = route53.HostedZone.fromHostedZoneAttributes(
      this,
      "SubdomainZone",
      {
        hostedZoneId: cdk.Fn.importValue("EarthquakeAgent-SubdomainZoneId"),
        zoneName: domainName,
      },
    );

    new route53.ARecord(this, "WebhookAliasRecord", {
      zone: subdomainZone,
      recordName: webhookDomainName,
      target: route53.RecordTarget.fromAlias(
        new route53targets.ApiGatewayDomain(api.domainName!),
      ),
      comment:
        "Alias to the Webhook Receiver custom domain (webhook.earthquake-agent.*)",
    });

    // --- Cross-stack exports --------------------------------------------------
    new cdk.CfnOutput(this, "WebhookCustomDomainUrl", {
      value: `https://${webhookDomainName}`,
      description: "Custom domain URL of the Webhook Receiver endpoint",
      exportName: "EarthquakeAgent-WebhookCustomDomainUrl",
    });

    new cdk.CfnOutput(this, "WebhookQueueArn", {
      value: eventQueue.queueArn,
      description:
        "ARN of the SQS queue that buffers validated webhook events (consumed by AgentStack)",
      exportName: "EarthquakeAgent-WebhookQueueArn",
    });

    new cdk.CfnOutput(this, "WebhookQueueUrl", {
      value: eventQueue.queueUrl,
      description: "URL of the SQS queue that buffers validated webhook events",
      exportName: "EarthquakeAgent-WebhookQueueUrl",
    });

    new cdk.CfnOutput(this, "WebhookDeadLetterQueueArn", {
      value: deadLetterQueue.queueArn,
      description: "ARN of the Webhook Receiver dead-letter queue",
      exportName: "EarthquakeAgent-WebhookDeadLetterQueueArn",
    });

    // --- Monitoring alarms ---------------------------------------------------
    addLambdaAlarms(this, "webhook-receiver", handlerFn);
    addLogErrorAlarm(this, "webhook-receiver", handlerFn);
    addApiGatewayAlarms(this, "webhook-api", api);
  }
}
