/**
 * Unit tests for the Webhook Receiver Lambda handler (task 5.4).
 *
 * The Data API subscription lookup is replaced with a mock
 * {@link SubscriptionLookup} via the `setSubscriptionLookupForTesting` seam, and
 * the SQS client is mocked with `aws-sdk-client-mock`, so these tests exercise
 * the real handler logic (header extraction, secret resolution, signature
 * verification, status mapping, and enqueue with the subscriptionId attribute)
 * without SigV4 signing or network/AWS access.
 *
 * Covered (Requirements 3.1-3.5, 17.9, 19.2):
 * - success: 200 + SQS enqueue carrying the subscriptionId message attribute,
 * - 400 when the Standard Webhooks headers are missing,
 * - 400 when the X-MCP-Subscription-Id header is missing,
 * - 401 for an invalid / mismatched signature,
 * - 401 for a replayed / expired (out-of-tolerance) timestamp.
 */

import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import type { APIGatewayProxyEvent } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  SUBSCRIPTION_ID_ATTRIBUTE,
  handler,
  setSubscriptionLookupForTesting,
  type SubscriptionLookupResult,
} from "./handler.js";
import {
  MCP_SUBSCRIPTION_ID_HEADER,
  signWebhook,
  type WebhookHeaders,
} from "./signature.js";

const QUEUE_URL =
  "https://sqs.us-east-1.amazonaws.com/123456789012/earthquake-agent-events";
const DATA_API_URL = "https://api.earthquake-agent.example.com";

const SUBSCRIPTION_ID = "22222222-2222-4222-8222-222222222222";
const CUSTOMER_ID = "33333333-3333-4333-8333-333333333333";
const EVENT_ID = "11111111-1111-4111-8111-111111111111";
/** A structurally valid `whsec_` secret (prefix + base64 of 32 bytes). */
const SECRET = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const WRONG_SECRET = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;

const PAYLOAD = JSON.stringify({
  eventId: EVENT_ID,
  name: "earthquake.detected",
  timestamp: "2024-01-01T00:00:00.000Z",
  data: { earthquakeId: "us7000n123", magnitude: 5.2 },
  cursor: "abc",
});

const sqsMock = mockClient(SQSClient);

/** Build a Data API lookup that returns the given subscription secret (200). */
function lookupReturningSecret(secret: string) {
  return vi.fn(
    async (_id: string): Promise<SubscriptionLookupResult> => ({
      statusCode: 200,
      body: JSON.stringify({
        subscriptionId: SUBSCRIPTION_ID,
        customerId: CUSTOMER_ID,
        secret,
      }),
    }),
  );
}

/** Build an API Gateway proxy event for a webhook delivery. */
function makeEvent(opts: {
  headers: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}): APIGatewayProxyEvent {
  return {
    httpMethod: "POST",
    path: "/webhook",
    headers: opts.headers,
    body: opts.body ?? PAYLOAD,
    isBase64Encoded: opts.isBase64Encoded ?? false,
  } as unknown as APIGatewayProxyEvent;
}

/**
 * Sign a payload (PAYLOAD by default) and merge the signature headers with the
 * subscription header.
 */
function signedHeaders(
  secret: string,
  options?: Parameters<typeof signWebhook>[2],
  body: string = PAYLOAD,
): Record<string, string> {
  const sig: WebhookHeaders = signWebhook(body, secret, options);
  return {
    [MCP_SUBSCRIPTION_ID_HEADER]: SUBSCRIPTION_ID,
    "webhook-id": sig["webhook-id"],
    "webhook-timestamp": sig["webhook-timestamp"],
    "webhook-signature": sig["webhook-signature"],
  };
}

beforeEach(() => {
  sqsMock.reset();
  process.env.EVENT_QUEUE_URL = QUEUE_URL;
  process.env.DATA_API_URL = DATA_API_URL;
});

afterEach(() => {
  setSubscriptionLookupForTesting(undefined);
  delete process.env.EVENT_QUEUE_URL;
  delete process.env.DATA_API_URL;
});

afterAll(() => {
  sqsMock.restore();
});

describe("webhook receiver handler", () => {
  it("returns 200 and enqueues the event with the subscriptionId attribute", async () => {
    const lookup = lookupReturningSecret(SECRET);
    setSubscriptionLookupForTesting(lookup);
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "m-1" });

    const res = await handler(makeEvent({ headers: signedHeaders(SECRET) }));

    expect(res.statusCode).toBe(200);
    expect(lookup).toHaveBeenCalledWith(SUBSCRIPTION_ID);

    const calls = sqsMock.commandCalls(SendMessageCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0].args[0].input;
    expect(input.QueueUrl).toBe(QUEUE_URL);
    expect(input.MessageBody).toBe(PAYLOAD);
    expect(input.MessageAttributes?.[SUBSCRIPTION_ID_ATTRIBUTE]).toEqual({
      DataType: "String",
      StringValue: SUBSCRIPTION_ID,
    });
    // FIFO: group by customer so one customer's events are serialized, and
    // deduplicate on the event id so a re-delivery enqueues once.
    expect(input.MessageGroupId).toBe(CUSTOMER_ID);
    expect(input.MessageDeduplicationId).toBe(EVENT_ID);
  });

  it("falls back to content-based deduplication when the body has no eventId", async () => {
    setSubscriptionLookupForTesting(lookupReturningSecret(SECRET));
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "m-1" });

    const body = JSON.stringify({ name: "earthquake.detected", data: {} });
    const res = await handler(
      makeEvent({ headers: signedHeaders(SECRET, undefined, body), body }),
    );

    expect(res.statusCode).toBe(200);
    const input = sqsMock.commandCalls(SendMessageCommand)[0].args[0].input;
    expect(input.MessageGroupId).toBe(CUSTOMER_ID);
    expect(input.MessageDeduplicationId).toBeUndefined();
  });

  it("returns 401 and enqueues nothing when the subscription has no customerId", async () => {
    // Without a customerId there is no correct FIFO message group, so the
    // delivery must not be enqueued under a guessed one.
    setSubscriptionLookupForTesting(
      vi.fn(
        async (_id: string): Promise<SubscriptionLookupResult> => ({
          statusCode: 200,
          body: JSON.stringify({
            subscriptionId: SUBSCRIPTION_ID,
            secret: SECRET,
          }),
        }),
      ),
    );

    const res = await handler(makeEvent({ headers: signedHeaders(SECRET) }));

    expect(res.statusCode).toBe(401);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it("decodes a base64-encoded body before verifying and enqueueing", async () => {
    setSubscriptionLookupForTesting(lookupReturningSecret(SECRET));
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "m-1" });

    const res = await handler(
      makeEvent({
        headers: signedHeaders(SECRET),
        body: Buffer.from(PAYLOAD, "utf8").toString("base64"),
        isBase64Encoded: true,
      }),
    );

    expect(res.statusCode).toBe(200);
    const input = sqsMock.commandCalls(SendMessageCommand)[0].args[0].input;
    expect(input.MessageBody).toBe(PAYLOAD);
  });

  it("returns 400 when the X-MCP-Subscription-Id header is missing", async () => {
    const lookup = lookupReturningSecret(SECRET);
    setSubscriptionLookupForTesting(lookup);

    // Sign normally but strip the subscription routing header.
    const headers = signedHeaders(SECRET);
    delete headers[MCP_SUBSCRIPTION_ID_HEADER];

    const res = await handler(makeEvent({ headers }));

    expect(res.statusCode).toBe(400);
    expect(lookup).not.toHaveBeenCalled();
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it("returns 400 when the Standard Webhooks signature headers are missing", async () => {
    setSubscriptionLookupForTesting(lookupReturningSecret(SECRET));

    // Subscription id present, but no webhook-id/timestamp/signature headers.
    const res = await handler(
      makeEvent({ headers: { [MCP_SUBSCRIPTION_ID_HEADER]: SUBSCRIPTION_ID } }),
    );

    expect(res.statusCode).toBe(400);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it("returns 401 for an invalid signature (wrong secret) and does not enqueue", async () => {
    // The delivery was signed with WRONG_SECRET, but the subscription's real
    // secret is SECRET, so verification must fail.
    setSubscriptionLookupForTesting(lookupReturningSecret(SECRET));

    const res = await handler(
      makeEvent({ headers: signedHeaders(WRONG_SECRET) }),
    );

    expect(res.statusCode).toBe(401);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it("returns 401 for a replayed / expired delivery regardless of signature", async () => {
    setSubscriptionLookupForTesting(lookupReturningSecret(SECRET));

    // Sign with the correct secret but a timestamp 10 minutes in the past, well
    // outside the 5-minute tolerance window (Requirement 3.3).
    const old = new Date(Date.now() - 10 * 60 * 1000);
    const res = await handler(
      makeEvent({ headers: signedHeaders(SECRET, { timestamp: old }) }),
    );

    expect(res.statusCode).toBe(401);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it("returns 401 when the subscription is unknown (Data API 404)", async () => {
    const lookup = vi.fn(
      async (_id: string): Promise<SubscriptionLookupResult> => ({
        statusCode: 404,
        body: JSON.stringify({ error: "Not Found" }),
      }),
    );
    setSubscriptionLookupForTesting(lookup);

    const res = await handler(makeEvent({ headers: signedHeaders(SECRET) }));

    expect(res.statusCode).toBe(401);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it("returns 500 when the Data API lookup fails upstream (so the server retries)", async () => {
    const lookup = vi.fn(
      async (_id: string): Promise<SubscriptionLookupResult> => ({
        statusCode: 503,
        body: "unavailable",
      }),
    );
    setSubscriptionLookupForTesting(lookup);

    const res = await handler(makeEvent({ headers: signedHeaders(SECRET) }));

    expect(res.statusCode).toBe(500);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });
});
