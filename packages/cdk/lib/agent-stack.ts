import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

import { addLambdaAlarms, addLogErrorAlarm } from "./alarms.js";
import { resolveDomainName, type SharedProps } from "./shared-props.js";

export type AgentStackProps = cdk.StackProps & SharedProps;

/**
 * Serverless Agent stack for the MCP Events Serverless Agent sample.
 *
 * Responsibilities (Requirements 4.x, 5.x, 6.x, 13.1, 17.3, 17.7, 19.4):
 * - A Lambda (the Strands Agent) triggered by the Webhook Receiver's SQS queue
 *   with a batch size of 1 so each event gets full execution time
 *   (Requirement 19.4). The queue ARN is imported from WebhookReceiverStack.
 * - A private S3 sessions bucket holding per-customer conversation history at
 *   `sessions/{customerId}/session.json`. The Strands SDK SessionManager reads
 *   and writes it directly (Requirement 4.3). Block all public access,
 *   S3-managed encryption, and SSL enforcement (Requirement 17.3).
 * - A DynamoDB session locks table keyed on `customerId` (partition) plus a
 *   constant `lockGroup` sort key, matching the @deliveryhero/dynamodb-lock
 *   client's composite-key contract, with a TTL attribute so a lock
 *   auto-releases after the lease (60 seconds) if an invocation crashes
 *   (Requirements 6.1, 6.4).
 * - A least-privilege execution role granting `execute-api:Invoke` on the Data
 *   API (the agent signs requests with SigV4 to resolve subscriptions and load
 *   config), `bedrock:InvokeModel` on the foundation models / inference
 *   profiles the Strands Agent invokes for its LLM analysis and briefing
 *   synthesis, read/write on the sessions bucket, and read/write on the locks
 *   table (Requirements 17.3, 17.7).
 *
 * CROSS-STACK CONTRACT: This stack exports the sessions bucket ARN under the
 * export name `EarthquakeAgent-SessionsBucketArn`. DataApiStack imports exactly
 * that name (via `cdk.Fn.importValue`) to grant its handler read-only
 * `s3:GetObject` for the session-messages endpoint (Requirements 9.8, 17.3).
 *
 * QUEUE IMPORT ORDERING: WebhookReceiverStack owns the SQS queue and exports
 * its ARN. AgentStack imports that ARN with `sqs.Queue.fromQueueArn` and
 * attaches it as a `SqsEventSource`. `Fn.importValue` is a deploy-time
 * CloudFormation intrinsic, so `cdk synth` works regardless of stack order; the
 * export only needs to exist at deploy time.
 *
 * LOCK TABLE NOTE: The agent uses the `@deliveryhero/dynamodb-lock` client
 * (configured in subtask 9.1) against this table. That client addresses lock
 * rows by a composite key, so the table is provisioned here with `customerId`
 * as the partition key, a constant `lockGroup` sort key, and a `ttl` TTL
 * attribute; subtask 9.1 configures the lock client's key/ttl names to match.
 *
 * HANDLER NOTE: The Lambda handler lives in the @mcp-events/agent package at
 * src/handler.ts (subtask 9.10). The NodejsFunction `entry` points at it and
 * the exported `handler` function is the SQS event handler.
 */
export class AgentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id, props);

    const domainName = resolveDomainName(props);
    // The Data API custom domain is created by DataApiStack (subtask 2.3). The
    // agent calls it with IAM-signed HTTP, so pass the URL as an environment
    // variable rather than a cross-stack import to avoid a synth-time ordering
    // dependency (same approach the MCP server stacks use for the webhook URL).
    const dataApiUrl = `https://api.${domainName}`;

    // --- S3: per-customer sessions bucket ------------------------------------
    // Private bucket; only the agent reads/writes it (the Data API gets a
    // narrow read-only grant via cross-stack import). Conversation history is
    // stored at sessions/{customerId}/session.json (Requirement 4.3).
    const sessionsBucket = new s3.Bucket(this, "SessionsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Demo sample: remove the bucket and its contents with the stack.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // --- DynamoDB: session locks ---------------------------------------------
    // The agent locks per customer via the @deliveryhero/dynamodb-lock client
    // (configured in subtask 9.1), which addresses lock rows by a composite key:
    // `customerId` (partition key) plus a constant `lockGroup` sort key. The
    // table schema must match that client contract, so both keys are declared
    // here. The TTL attribute auto-releases locks held by crashed invocations
    // after the lease elapses (Requirements 6.1, 6.4), and the lock client uses
    // conditional writes for owner-only release (Requirement 6.5).
    const sessionLocksTable = new dynamodb.Table(this, "SessionLocksTable", {
      partitionKey: { name: "customerId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "lockGroup", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- SQS: Webhook Receiver queue + dead-letter queue ---------------------
    // The Webhook Receiver owns both queues and exports their ARNs. The agent
    // consumes the main queue (event source below) and sends permanently
    // un-routable events to the DLQ for investigation rather than burning the
    // SQS retry budget (Requirement 15.6, design Error Scenario 9).
    const eventQueue = sqs.Queue.fromQueueArn(
      this,
      "WebhookEventQueue",
      cdk.Fn.importValue("EarthquakeAgent-WebhookQueueArn"),
    );
    const deadLetterQueue = sqs.Queue.fromQueueArn(
      this,
      "WebhookDeadLetterQueue",
      cdk.Fn.importValue("EarthquakeAgent-WebhookDeadLetterQueueArn"),
    );

    // --- Lambda handler -------------------------------------------------------
    // Compiled stack lives at packages/cdk/dist/lib, so walk up to the repo's
    // packages/ directory to reach the agent source and up to the repo root for
    // the workspace lock file (same pattern as DataApiStack).
    const agentPackageRoot = path.join(__dirname, "..", "..", "..", "agent");
    const handlerFn = new NodejsFunction(this, "AgentHandler", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(agentPackageRoot, "src", "handler.ts"),
      handler: "handler",
      memorySize: 512,
      // The agent invokes the LLM per event; give it generous headroom while
      // staying within the queue visibility timeout (Requirement 19.6).
      timeout: cdk.Duration.seconds(300),
      depsLockFilePath: path.join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "package-lock.json",
      ),
      environment: {
        SESSIONS_BUCKET_NAME: sessionsBucket.bucketName,
        SESSION_LOCKS_TABLE_NAME: sessionLocksTable.tableName,
        DATA_API_URL: dataApiUrl,
        DEAD_LETTER_QUEUE_URL: deadLetterQueue.queueUrl,
      },
    });

    // --- SQS event source (batch size 1) -------------------------------------
    // Attach the imported Webhook Receiver queue as the agent's trigger. Batch
    // size 1 ensures one event per Lambda invocation (Requirement 19.4); report
    // batch item failures so a failed message returns to the queue and
    // eventually the DLQ (Requirement 15.2).
    //
    // The queue is FIFO with `MessageGroupId = customerId`, so Lambda delivers a
    // single customer's events strictly one at a time — the agent's per-customer
    // session lock is therefore uncontended in normal operation and acts as a
    // backstop rather than the primary serialization mechanism.
    //
    // maxConcurrency is NOT what serializes a customer (it cannot be: the API's
    // minimum is 2, which is exactly what used to let two invocations race for
    // one customer's lock). Its only job is bounding total fan-out. For FIFO,
    // effective concurrency is the lower of this value and the number of active
    // message groups, so per customer the binding constraint is always FIFO's
    // one-per-group; this ceiling only caps how many DIFFERENT customers process
    // at once (Requirement 19.5).
    handlerFn.addEventSource(
      new SqsEventSource(eventQueue, {
        batchSize: 1,
        maxConcurrency: 500,
        reportBatchItemFailures: true,
      }),
    );

    // --- IAM grants (least privilege) ----------------------------------------
    // The agent owns its session bucket and lock table directly.
    sessionsBucket.grantReadWrite(handlerFn);
    sessionLocksTable.grantReadWriteData(handlerFn);

    // Send-only access to the DLQ for the explicit dead-lettering path above
    // (Requirement 15.6). Its URL is passed to the handler via
    // DEAD_LETTER_QUEUE_URL.
    deadLetterQueue.grantSendMessages(handlerFn);

    // execute-api:Invoke on the Data API so the agent can resolve
    // subscriptionId -> customerId and load CustomerConfig via SigV4-signed
    // HTTP (Requirement 17.7). DataApiStack is created separately and does not
    // export its API id, so scope the grant to this account/region's
    // execute-api namespace (same approach as DataApiStack's scheduler grant).
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

    // bedrock:InvokeModel(+ WithResponseStream) so the Strands Agent can invoke
    // the LLM, which is the agent's core function (it constructs a BedrockModel
    // and calls it for every earthquake analysis and briefing synthesis). The
    // model id is configurable via the BEDROCK_MODEL_ID environment variable
    // (default anthropic.claude-3-5-sonnet), and Bedrock on-demand throughput
    // for newer Anthropic models is reached through a cross-region inference
    // profile that fans out to foundation models in sibling regions. Scope the
    // grant to this account's foundation-model and inference-profile ARNs
    // across regions so any configured model resolves without granting "*"
    // (Requirements 13.5, 17.3 least privilege).
    handlerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
        ],
        resources: [
          // Foundation models are AWS-owned, so the account id is empty in the
          // ARN; allow any region so cross-region inference profiles resolve.
          `arn:${cdk.Aws.PARTITION}:bedrock:*::foundation-model/*`,
          // Inference profiles are account-scoped.
          cdk.Stack.of(this).formatArn({
            service: "bedrock",
            region: "*",
            resource: "inference-profile",
            resourceName: "*",
            arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
          }),
        ],
      }),
    );

    // --- Cross-stack exports --------------------------------------------------
    // DataApiStack imports this exact export name for its read-only session
    // messages endpoint (Requirements 9.8, 17.3).
    new cdk.CfnOutput(this, "SessionsBucketArn", {
      value: sessionsBucket.bucketArn,
      description:
        "ARN of the agent sessions S3 bucket (read-only access granted to the Data API)",
      exportName: "EarthquakeAgent-SessionsBucketArn",
    });

    new cdk.CfnOutput(this, "SessionsBucketName", {
      value: sessionsBucket.bucketName,
      description: "Name of the agent sessions S3 bucket",
      exportName: "EarthquakeAgent-SessionsBucketName",
    });

    new cdk.CfnOutput(this, "SessionLocksTableName", {
      value: sessionLocksTable.tableName,
      description: "Name of the DynamoDB session locks table",
      exportName: "EarthquakeAgent-SessionLocksTableName",
    });

    // --- Monitoring alarms ---------------------------------------------------
    addLambdaAlarms(this, "agent", handlerFn);
    addLogErrorAlarm(this, "agent", handlerFn);
  }
}
