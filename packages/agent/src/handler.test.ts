/**
 * Unit tests for the Serverless Agent SQS handler (task 9.10).
 *
 * These tests wire the REAL building blocks (router -> config load -> lock ->
 * corrupted-session recovery -> earthquake/briefing processing) together and
 * exercise the whole pipeline against test doubles only — no AWS, no LLM:
 * - the Data API subscription lookup ({@link setSubscriptionLookupForTesting})
 *   and config lookup ({@link setConfigLookupForTesting}) are faked,
 * - the SQS client (router dead-lettering) is mocked with `aws-sdk-client-mock`,
 * - the S3 client (sessions bucket + corruption archival) is mocked,
 * - the LLM model is a {@link FakeModel} / {@link ToolCallingModel} double, and
 * - the distributed lock uses an in-memory {@link FakeLockClient} via
 *   {@link setLockClientForTesting}, including a mode that times out.
 *
 * Covered behaviors (Requirements 4.1-4.7, 6.3, 15.2, 15.5):
 * - earthquake routed + processed (session persisted, no batch failure),
 * - briefing routed + processed (report saved, no batch failure),
 * - dead-lettered record -> handled, no batch failure,
 * - lock acquisition timeout -> batch item failure (SQS retry),
 * - processing error (transient Data API) -> batch item failure,
 * - missing customer config -> dropped, no batch failure,
 * - corrupted session -> archived aside, processing continues from fresh.
 */

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import type { BriefingReport, CustomerConfig } from "@mcp-events/shared";
import {
  Model,
  type Message,
  type ModelStreamEvent,
  type Snapshot,
  type StreamOptions,
} from "@strands-agents/sdk";
import type { Lock } from "@deliveryhero/dynamodb-lock";
import type { SQSEvent, SQSRecord } from "aws-lambda";
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
  SESSION_METADATA_KEY,
  setModelForTesting,
  setS3ClientForTesting,
  type SessionMetadata,
} from "./accumulate.js";
import {
  setReportWriterForTesting,
  type ReportWriteResult,
} from "./briefing.js";
import {
  setConfigLookupForTesting,
  type ConfigLookupResult,
} from "./config.js";
import {
  LOCK_ACQUISITION_TIMEOUT_MS,
  LOCK_GROUP,
  setLockClientForTesting,
  type SessionLockClient,
} from "./lock.js";
import { handler } from "./handler.js";
import {
  SUBSCRIPTION_ID_ATTRIBUTE,
  setSqsClientForTesting,
  setSubscriptionLookupForTesting,
  type SubscriptionLookupResult,
} from "./router.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BUCKET_NAME = "test-sessions-bucket";
const DATA_API_URL = "https://api.earthquake-agent.example.com";
const DLQ_URL =
  "https://sqs.us-east-1.amazonaws.com/123456789012/earthquake-agent-events-dlq";

const SUBSCRIPTION_ID = "22222222-2222-4222-8222-222222222222";
const CUSTOMER_ID = "33333333-3333-4333-8333-333333333333";
const EARTHQUAKE_EVENT_ID = "11111111-1111-4111-8111-111111111111";
const BRIEFING_EVENT_ID = "44444444-4444-4444-8444-444444444444";
const ANALYSIS_TEXT = "Moderate earthquake; monitoring aftershocks.";

const s3Mock = mockClient(S3Client);
const sqsMock = mockClient(SQSClient);

/** A valid `earthquake.detected` MCP event payload. */
const EARTHQUAKE_EVENT = {
  eventId: EARTHQUAKE_EVENT_ID,
  name: "earthquake.detected",
  timestamp: "2024-01-01T00:00:00.000Z",
  data: {
    earthquakeId: "us7000n123",
    magnitude: 5.2,
    place: "10km SW of Ridgecrest, CA",
    coordinates: { longitude: -117.5, latitude: 35.6, depth: 8.2 },
    time: "2024-01-01T00:00:00.000Z",
    tsunami: false,
    felt: 12,
    alert: "green",
    url: "https://earthquake.usgs.gov/earthquakes/eventpage/us7000n123",
  },
  cursor: "cursor-1",
};

/** A valid `briefing.trigger` MCP event payload. */
const BRIEFING_EVENT = {
  eventId: BRIEFING_EVENT_ID,
  name: "briefing.trigger",
  timestamp: "2024-02-01T09:00:00.000Z",
  data: {
    triggerType: "scheduled",
    customerId: CUSTOMER_ID,
    scheduledTime: "2024-02-01T09:00:00.000Z",
  },
  cursor: "cursor-2",
};

/** Narrative fields the briefing fake model supplies to save_report. */
const SAVE_REPORT_INPUT = {
  summary: "One moderate earthquake struck the region this period.",
  notableQuakes: [
    {
      earthquakeId: "us7000n123",
      magnitude: 5.2,
      place: "10km SW of Ridgecrest, CA",
      reason: "Largest of the period.",
    },
  ],
  geographicPatterns: "Clustered along the Eastern California Shear Zone.",
  comparisonToPrevious: "Slightly more active than the previous period.",
};

/** A minimal CustomerConfig for the test customer. */
function makeConfig(overrides: Partial<CustomerConfig> = {}): CustomerConfig {
  return {
    customerId: CUSTOMER_ID,
    displayName: "Test Customer",
    subscriptionParams: { minMagnitude: 2.5 },
    briefingPrompt: "You are a seismologist. Analyze earthquakes concisely.",
    briefingSchedule: 24,
    active: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Build an SQS record carrying the given event body and subscription id. */
function makeRecord(opts: {
  body: string;
  subscriptionId?: string;
  messageId?: string;
}): SQSRecord {
  const messageAttributes: SQSRecord["messageAttributes"] = {};
  if (opts.subscriptionId !== undefined) {
    messageAttributes[SUBSCRIPTION_ID_ATTRIBUTE] = {
      stringValue: opts.subscriptionId,
      dataType: "String",
      stringListValues: [],
      binaryListValues: [],
    };
  }
  return {
    messageId: opts.messageId ?? "msg-1",
    receiptHandle: "rh-1",
    body: opts.body,
    attributes: {} as SQSRecord["attributes"],
    messageAttributes,
    md5OfBody: "",
    eventSource: "aws:sqs",
    eventSourceARN:
      "arn:aws:sqs:us-east-1:123456789012:earthquake-agent-events",
    awsRegion: "us-east-1",
  };
}

/** Wrap one or more records as an SQSEvent. */
function makeEvent(records: SQSRecord[]): SQSEvent {
  return { Records: records };
}

// ---------------------------------------------------------------------------
// Fake models
// ---------------------------------------------------------------------------

/** Streams a single fixed text response (earthquake analysis). */
class FakeModel extends Model {
  public readonly calls: Message[][] = [];
  constructor(private readonly text: string = ANALYSIS_TEXT) {
    super();
  }
  updateConfig(): void {
    // no-op
  }
  getConfig(): { modelId: string } {
    return { modelId: "fake-model" };
  }
  async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    this.calls.push([...messages]);
    yield { type: "modelMessageStartEvent", role: "assistant" };
    yield { type: "modelContentBlockStartEvent" };
    yield {
      type: "modelContentBlockDeltaEvent",
      delta: { type: "textDelta", text: this.text },
    };
    yield { type: "modelContentBlockStopEvent" };
    yield { type: "modelMessageStopEvent", stopReason: "endTurn" };
  }
}

/** Simulates an LLM calling `save_report`, then ending the turn. */
class ToolCallingModel extends Model {
  public callCount = 0;
  public readonly calls: Message[][] = [];
  constructor(private readonly toolInput: unknown = SAVE_REPORT_INPUT) {
    super();
  }
  updateConfig(): void {
    // no-op
  }
  getConfig(): { modelId: string } {
    return { modelId: "fake-tool-model" };
  }
  async *stream(
    messages: Message[],
    _options?: StreamOptions,
  ): AsyncIterable<ModelStreamEvent> {
    this.calls.push([...messages]);
    this.callCount += 1;
    if (this.callCount === 1) {
      yield { type: "modelMessageStartEvent", role: "assistant" };
      yield {
        type: "modelContentBlockStartEvent",
        start: {
          type: "toolUseStart",
          name: "save_report",
          toolUseId: "tool-use-1",
        },
      };
      yield {
        type: "modelContentBlockDeltaEvent",
        delta: {
          type: "toolUseInputDelta",
          input: JSON.stringify(this.toolInput),
        },
      };
      yield { type: "modelContentBlockStopEvent" };
      yield { type: "modelMessageStopEvent", stopReason: "toolUse" };
      return;
    }
    yield { type: "modelMessageStartEvent", role: "assistant" };
    yield { type: "modelContentBlockStartEvent" };
    yield {
      type: "modelContentBlockDeltaEvent",
      delta: { type: "textDelta", text: "Briefing report saved." },
    };
    yield { type: "modelContentBlockStopEvent" };
    yield { type: "modelMessageStopEvent", stopReason: "endTurn" };
  }
}

// ---------------------------------------------------------------------------
// Fake distributed lock
// ---------------------------------------------------------------------------

/**
 * In-memory {@link SessionLockClient} for the handler tests. Records the
 * lock/release calls so a test can assert serialization, and can be put into a
 * "never grants" mode that hangs forever — which {@link withLock} races against
 * its 10s timer, surfacing a {@link LockAcquisitionTimeoutError}. To keep the
 * timeout test fast we shorten that timer with fake timers.
 */
class FakeLockClient implements SessionLockClient {
  public lockCalls: { lockGroup: string; lockId: string }[] = [];
  public releaseCount = 0;
  constructor(private readonly mode: "grant" | "hang" = "grant") {}

  async lock(lockGroup: string, lockId: string): Promise<Lock> {
    this.lockCalls.push({ lockGroup, lockId });
    if (this.mode === "hang") {
      // Never resolves; withLock's acquisition-timeout timer wins the race.
      return new Promise<Lock>(() => {
        /* intentionally never settles */
      });
    }
    return { lockId, lockGroup, isAcquired: true } as unknown as Lock;
  }

  async releaseLock(_lock: Lock): Promise<void> {
    this.releaseCount += 1;
  }
}

// ---------------------------------------------------------------------------
// Lookup / writer fakes
// ---------------------------------------------------------------------------

function lookupReturningCustomer(customerId: string) {
  return vi.fn(
    async (_id: string): Promise<SubscriptionLookupResult> => ({
      statusCode: 200,
      body: JSON.stringify({ subscriptionId: SUBSCRIPTION_ID, customerId }),
    }),
  );
}

function configReturning(config: CustomerConfig) {
  return vi.fn(
    async (_customerId: string): Promise<ConfigLookupResult> => ({
      statusCode: 200,
      body: JSON.stringify(config),
    }),
  );
}

// ---------------------------------------------------------------------------
// S3 mock helpers
// ---------------------------------------------------------------------------

function streamBody(text: string): GetObjectCommandOutput["Body"] {
  return {
    transformToString: async () => text,
  } as unknown as GetObjectCommandOutput["Body"];
}

function sessionKey(): string {
  return `sessions/${CUSTOMER_ID}/scopes/agent/agent/snapshots/snapshot_latest.json`;
}

function makeSnapshot(opts: {
  messages?: { role: "user" | "assistant"; text: string }[];
  metadata?: Partial<SessionMetadata>;
}): Snapshot {
  const messages = (opts.messages ?? []).map((m) => ({
    role: m.role,
    content: [{ text: m.text }],
  }));
  const state: Record<string, unknown> = {};
  if (opts.metadata) {
    state[SESSION_METADATA_KEY] = {
      lastEventId: "",
      lastActiveAt: "",
      invocationCount: 0,
      lastBriefingAt: null,
      customerDisplayName: "Test Customer",
      processedEventIds: [],
      ...opts.metadata,
    };
  }
  return {
    scope: "agent",
    schemaVersion: "1.0",
    createdAt: "2024-01-01T00:00:00.000Z",
    data: { messages, state },
    appData: {},
  } as unknown as Snapshot;
}

function persistedSnapshot(): Snapshot | undefined {
  const calls = s3Mock
    .commandCalls(PutObjectCommand)
    .filter((call) => call.args[0].input.Key === sessionKey());
  const last = calls.at(-1);
  if (!last) {
    return undefined;
  }
  return JSON.parse(last.args[0].input.Body as string) as Snapshot;
}

/** A no-such-key error matching the S3 SDK shape. */
function noSuchKey(): Error {
  return Object.assign(new Error("missing"), { name: "NoSuchKey" });
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let lockClient: FakeLockClient;

beforeEach(() => {
  s3Mock.reset();
  sqsMock.reset();
  setS3ClientForTesting(s3Mock as unknown as S3Client);
  setSqsClientForTesting(sqsMock as unknown as SQSClient);
  s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
  s3Mock.on(PutObjectCommand).resolves({});
  s3Mock.on(CopyObjectCommand).resolves({});
  s3Mock.on(DeleteObjectCommand).resolves({});
  sqsMock.on(SendMessageCommand).resolves({ MessageId: "dlq-1" });

  lockClient = new FakeLockClient("grant");
  setLockClientForTesting(lockClient);

  process.env.SESSIONS_BUCKET_NAME = BUCKET_NAME;
  process.env.DATA_API_URL = DATA_API_URL;
  process.env.DEAD_LETTER_QUEUE_URL = DLQ_URL;
});

afterEach(() => {
  setS3ClientForTesting(undefined);
  setSqsClientForTesting(undefined);
  setModelForTesting(undefined);
  setReportWriterForTesting(undefined);
  setSubscriptionLookupForTesting(undefined);
  setConfigLookupForTesting(undefined);
  setLockClientForTesting(undefined);
  vi.useRealTimers();
  delete process.env.SESSIONS_BUCKET_NAME;
  delete process.env.DATA_API_URL;
  delete process.env.DEAD_LETTER_QUEUE_URL;
});

afterAll(() => {
  s3Mock.restore();
  sqsMock.restore();
});

// ---------------------------------------------------------------------------
// Earthquake path
// ---------------------------------------------------------------------------

describe("handler — earthquake.detected", () => {
  it("routes, locks, processes, and persists with no batch failure", async () => {
    const model = new FakeModel();
    setModelForTesting(model);
    setSubscriptionLookupForTesting(lookupReturningCustomer(CUSTOMER_ID));
    setConfigLookupForTesting(configReturning(makeConfig()));
    // No prior session.
    s3Mock.on(GetObjectCommand, { Key: sessionKey() }).rejects(noSuchKey());

    const response = await handler(
      makeEvent([
        makeRecord({
          body: JSON.stringify(EARTHQUAKE_EVENT),
          subscriptionId: SUBSCRIPTION_ID,
        }),
      ]),
      {} as never,
      () => undefined,
    );

    expect(response).toEqual({ batchItemFailures: [] });

    // The customer was locked (and released) exactly once.
    expect(lockClient.lockCalls).toEqual([
      { lockGroup: LOCK_GROUP, lockId: CUSTOMER_ID },
    ]);
    expect(lockClient.releaseCount).toBe(1);

    // The LLM was invoked and the session persisted with the new exchange.
    expect(model.calls).toHaveLength(1);
    const snapshot = persistedSnapshot();
    expect(snapshot).toBeDefined();
    const data = snapshot!.data as unknown as {
      messages: { role: string }[];
      state: Record<string, SessionMetadata>;
    };
    expect(data.messages).toHaveLength(2);
    expect(data.state[SESSION_METADATA_KEY].processedEventIds).toContain(
      EARTHQUAKE_EVENT_ID,
    );
  });
});

// ---------------------------------------------------------------------------
// Briefing path
// ---------------------------------------------------------------------------

describe("handler — briefing.trigger", () => {
  it("routes, locks, generates a report via the Data API, no batch failure", async () => {
    setModelForTesting(new ToolCallingModel());
    setSubscriptionLookupForTesting(lookupReturningCustomer(CUSTOMER_ID));
    setConfigLookupForTesting(configReturning(makeConfig()));
    const writer = vi.fn(
      async (
        _customerId: string,
        _report: BriefingReport,
      ): Promise<ReportWriteResult> => ({ statusCode: 201, body: "{}" }),
    );
    setReportWriterForTesting(writer);

    // Seed a session with one earthquake observation so the briefing has
    // activity to report on.
    s3Mock.on(GetObjectCommand, { Key: sessionKey() }).resolves({
      Body: streamBody(
        JSON.stringify(
          makeSnapshot({
            messages: [
              {
                role: "user",
                text: "A new earthquake has been detected:\n- ID: us7000n123\n- Magnitude: 5.2\n- Location: 10km SW of Ridgecrest, CA\n- Time: 2024-01-15T03:00:00.000Z",
              },
              { role: "assistant", text: "Moderate quake." },
            ],
            metadata: { invocationCount: 1 },
          }),
        ),
      ),
    });

    const response = await handler(
      makeEvent([
        makeRecord({
          body: JSON.stringify(BRIEFING_EVENT),
          subscriptionId: SUBSCRIPTION_ID,
        }),
      ]),
      {} as never,
      () => undefined,
    );

    expect(response).toEqual({ batchItemFailures: [] });
    expect(writer).toHaveBeenCalledTimes(1);
    expect(lockClient.releaseCount).toBe(1);
    const reportArg = writer.mock.calls[0][1];
    expect(reportArg.customerId).toBe(CUSTOMER_ID);
    expect(reportArg.totalEarthquakes).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Dead-letter / drop paths (no batch failure)
// ---------------------------------------------------------------------------

describe("handler — handled-without-retry outcomes", () => {
  it("treats a dead-lettered record as handled (no batch failure, no lock)", async () => {
    // Missing subscriptionId attribute -> router dead-letters the record.
    setSubscriptionLookupForTesting(lookupReturningCustomer(CUSTOMER_ID));
    setConfigLookupForTesting(configReturning(makeConfig()));

    const response = await handler(
      makeEvent([makeRecord({ body: JSON.stringify(EARTHQUAKE_EVENT) })]),
      {} as never,
      () => undefined,
    );

    expect(response).toEqual({ batchItemFailures: [] });
    // The record was sent to the DLQ and never locked or processed.
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
    expect(lockClient.lockCalls).toHaveLength(0);
  });

  it("drops an event for a customer with no config (404) without a batch failure", async () => {
    setModelForTesting(new FakeModel());
    setSubscriptionLookupForTesting(lookupReturningCustomer(CUSTOMER_ID));
    setConfigLookupForTesting(
      vi.fn(
        async (): Promise<ConfigLookupResult> => ({
          statusCode: 404,
          body: JSON.stringify({ error: "Not Found" }),
        }),
      ),
    );

    const response = await handler(
      makeEvent([
        makeRecord({
          body: JSON.stringify(EARTHQUAKE_EVENT),
          subscriptionId: SUBSCRIPTION_ID,
        }),
      ]),
      {} as never,
      () => undefined,
    );

    expect(response).toEqual({ batchItemFailures: [] });
    // No config -> no lock acquired, no session written.
    expect(lockClient.lockCalls).toHaveLength(0);
    expect(persistedSnapshot()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Retry paths (batch item failure)
// ---------------------------------------------------------------------------

describe("handler — batch item failures (SQS retry)", () => {
  it("reports a batch item failure on lock acquisition timeout", async () => {
    vi.useFakeTimers();
    setModelForTesting(new FakeModel());
    setSubscriptionLookupForTesting(lookupReturningCustomer(CUSTOMER_ID));
    setConfigLookupForTesting(configReturning(makeConfig()));
    s3Mock.on(GetObjectCommand, { Key: sessionKey() }).rejects(noSuchKey());
    // Lock never grants -> withLock's acquisition timer fires.
    setLockClientForTesting(new FakeLockClient("hang"));

    const promise = handler(
      makeEvent([
        makeRecord({
          body: JSON.stringify(EARTHQUAKE_EVENT),
          subscriptionId: SUBSCRIPTION_ID,
          messageId: "msg-lock-timeout",
        }),
      ]),
      {} as never,
      () => undefined,
    );

    // Advance past the lock acquisition timeout (read from the constant so
    // this cannot drift if the budget is retuned).
    await vi.advanceTimersByTimeAsync(LOCK_ACQUISITION_TIMEOUT_MS);
    const response = await promise;

    expect(response).toEqual({
      batchItemFailures: [{ itemIdentifier: "msg-lock-timeout" }],
    });
    // Nothing was persisted; the message will retry.
    expect(persistedSnapshot()).toBeUndefined();
  });

  it("reports a batch item failure on a transient Data API failure", async () => {
    setModelForTesting(new FakeModel());
    setSubscriptionLookupForTesting(lookupReturningCustomer(CUSTOMER_ID));
    // Config lookup returns 503 -> loadCustomerConfig throws -> retry.
    setConfigLookupForTesting(
      vi.fn(
        async (): Promise<ConfigLookupResult> => ({
          statusCode: 503,
          body: "unavailable",
        }),
      ),
    );

    const response = await handler(
      makeEvent([
        makeRecord({
          body: JSON.stringify(EARTHQUAKE_EVENT),
          subscriptionId: SUBSCRIPTION_ID,
          messageId: "msg-transient",
        }),
      ]),
      {} as never,
      () => undefined,
    );

    expect(response).toEqual({
      batchItemFailures: [{ itemIdentifier: "msg-transient" }],
    });
    expect(lockClient.lockCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Corrupted-session recovery (Requirement 15.5)
// ---------------------------------------------------------------------------

describe("handler — corrupted session recovery", () => {
  it("archives a corrupt session aside and processes from a fresh session", async () => {
    const model = new FakeModel();
    setModelForTesting(model);
    setSubscriptionLookupForTesting(lookupReturningCustomer(CUSTOMER_ID));
    setConfigLookupForTesting(configReturning(makeConfig()));

    // First GET (recovery inspection) returns corrupt bytes; after archival the
    // SnapshotStorage restore GET should see no session. We simulate that by
    // returning unparseable JSON on the first call and NoSuchKey afterwards.
    let getCount = 0;
    s3Mock.on(GetObjectCommand, { Key: sessionKey() }).callsFake(() => {
      getCount += 1;
      if (getCount === 1) {
        return { Body: streamBody("{ this is not valid json") };
      }
      throw noSuchKey();
    });

    const response = await handler(
      makeEvent([
        makeRecord({
          body: JSON.stringify(EARTHQUAKE_EVENT),
          subscriptionId: SUBSCRIPTION_ID,
        }),
      ]),
      {} as never,
      () => undefined,
    );

    expect(response).toEqual({ batchItemFailures: [] });

    // The corrupt object was copied aside to a -corrupted- key and the original
    // deleted (Requirement 15.5).
    const copyCalls = s3Mock.commandCalls(CopyObjectCommand);
    expect(copyCalls).toHaveLength(1);
    expect(copyCalls[0].args[0].input.Key).toContain(
      `${sessionKey()}-corrupted-`,
    );
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);

    // Processing continued: the LLM ran and a fresh session was persisted.
    expect(model.calls).toHaveLength(1);
    const snapshot = persistedSnapshot();
    expect(snapshot).toBeDefined();
    const data = snapshot!.data as unknown as { messages: unknown[] };
    // Fresh session: only the new user message + assistant response.
    expect(data.messages).toHaveLength(2);
  });
});
