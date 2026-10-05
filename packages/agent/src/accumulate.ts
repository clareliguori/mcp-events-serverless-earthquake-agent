/**
 * Earthquake event processing for the Serverless Agent (task 9.4).
 *
 * The agent uses the **conversation history as the accumulator** — there is no
 * separate earthquake list. When an `earthquake.detected` event arrives, this
 * module:
 *
 * 1. Restores the customer's session from S3 (Strands SDK `SessionManager`
 *    backed by the SDK's own {@link S3Storage}, sessionId = customerId,
 *    persisted at the SDK snapshot key
 *    `sessions/{customerId}/scopes/agent/agent/snapshots/snapshot_latest.json`)
 *    — Requirement 4.3/4.4.
 * 2. Performs an **idempotency check**: if the event's `eventId` is already in
 *    the session metadata, processing is skipped and success is returned so a
 *    duplicate SQS delivery never adds the same earthquake twice
 *    (Requirements 7.1, 7.2).
 * 3. Injects the earthquake data as a **user message** and invokes the LLM,
 *    which responds with analysis (significance, patterns relative to prior
 *    quakes already in the conversation) — Requirement 4.4.
 * 4. Persists the updated conversation history (user message + assistant
 *    response) and updated metadata back to S3 via the `SessionManager`
 *    (explicit save after a successful invocation) — Requirement 4.4.
 *
 * ## SDK persistence note
 *
 * Persistence uses the SDK's official {@link S3Storage} (imported from the
 * `@strands-agents/sdk/session/s3-storage` subpath — it is not re-exported from
 * the package root). It is configured with `bucket = SESSIONS_BUCKET_NAME`,
 * `prefix = "sessions"`, and the shared {@link getS3Client} so the test seam
 * keeps working. The `SessionManager` sets `scope = "agent"` and
 * `scopeId = agent.id`; the agent is constructed without an explicit `id`, so
 * `agent.id` defaults to `"agent"`. With `sessionId = customerId` the canonical
 * "latest" snapshot therefore lives at the SDK key
 * `sessions/{customerId}/scopes/agent/agent/snapshots/snapshot_latest.json`
 * (see {@link sessionSnapshotKey}). The persisted object is the SDK `Snapshot`
 * shape (`{ data: { messages, state, ... } }`), which the Data API session
 * reader (task 4.6) already understands (it reads `data.messages`).
 *
 * ## Testability
 *
 * The module exposes two test seams that mirror the conventions in `lock.ts`
 * and `router.ts` (module-level singletons with `setXForTesting` overrides):
 * - {@link setModelForTesting} swaps the Bedrock model for a fake so unit tests
 *   never call a real LLM, and
 * - {@link setS3ClientForTesting} swaps the S3 client so the real
 *   `Agent` + `SessionManager` + {@link S3Storage} run against a mocked bucket.
 *
 * This lets the unit tests exercise the genuine restore -> idempotency ->
 * inject -> invoke -> persist path without AWS or model access.
 */

import { S3Client } from "@aws-sdk/client-s3";
import type {
  CustomerConfig,
  EarthquakeDetectedData,
  McpEventPayload,
} from "@mcp-events/shared";
import {
  Agent,
  BedrockModel,
  SessionManager,
  SlidingWindowConversationManager,
  type ConversationManager,
  type Model,
  type ToolList,
} from "@strands-agents/sdk";
import { S3Storage } from "@strands-agents/sdk/session/s3-storage";

import { withTimeout } from "./timeout.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * appState key under which per-session metadata (idempotency bookkeeping,
 * activity counters) is stored. Kept out of the conversation history so it is
 * never sent to the model, but still captured in the session snapshot's
 * `data.state` and therefore persisted/restored across invocations.
 */
export const SESSION_METADATA_KEY = "sessionMetadata";

/**
 * S3 key prefix under which all session snapshots live, passed to the SDK's
 * {@link S3Storage} as its `prefix`. The SDK composes the full object key as
 * `<prefix>/<sessionId>/scopes/<scope>/<scopeId>/snapshots/...`.
 */
export const SESSION_SNAPSHOT_PREFIX = "sessions";

/**
 * The scope id the SDK `SessionManager` uses for an agent snapshot. It equals
 * `agent.id`, which defaults to the SDK's `DEFAULT_AGENT_ID` (`"agent"`) since
 * {@link buildAgent} constructs the `Agent` without an explicit `id`. Combined
 * with the SDK's fixed `scope = "agent"`, this yields the
 * `scopes/agent/agent/` segment of the snapshot key.
 */
export const AGENT_SCOPE_ID = "agent";

/**
 * Maximum number of recently-processed event IDs retained for the idempotency
 * check (a rolling window, mirroring the USGS cursor's bounded `lastSeenIds`).
 * With an expected load of 5-15 events/day/customer this comfortably covers any
 * realistic SQS redelivery window without growing the session unbounded.
 */
export const PROCESSED_EVENT_IDS_LIMIT = 200;

/**
 * Maximum number of messages retained in the conversation history between
 * briefings. Each earthquake event produces two messages (user + assistant), so
 * a window of 500 retains roughly the last 250 earthquakes. With the M1.0+ feed
 * reporting 100-200 quakes/day, this covers 1-2 full days of history - enough
 * for the briefing LLM to synthesize a meaningful report. The briefing path
 * still sees the full persisted history (via NullConversationManager) before
 * clearing; this window only bounds what is sent to the model during earthquake
 * analysis and what is persisted to S3 after each event, preventing context
 * window overflow for customers with infrequent briefing schedules.
 */
export const CONVERSATION_WINDOW_SIZE = 300;

/**
 * Default Bedrock model id used when `BEDROCK_MODEL_ID` is not set in the
 * environment. Uses the US cross-region inference profile for Claude Haiku 4.5,
 * a current (non-legacy) on-demand model well suited to this workload (5-15
 * events/day per customer). The agent's IAM role grants `bedrock:InvokeModel`
 * on both foundation-model and inference-profile ARNs across regions, so this
 * profile resolves without further changes. Override it via the
 * `BEDROCK_MODEL_ID` env var without a code change.
 *
 * Note: earlier Claude 3.x defaults are now rejected by Bedrock — the 3.5
 * Sonnet 20240620 model reached end of life, and 3.5 Haiku is marked Legacy
 * with access denied for accounts that have not used it recently.
 */
const DEFAULT_BEDROCK_MODEL_ID = "global.anthropic.claude-haiku-4-5-20251001-v1:0";

/**
 * Resolve the sessions bucket name from the environment (set by AgentStack).
 *
 * Exported so the corrupted-session recovery path (task 9.10) archives the
 * corrupt object in the same bucket without duplicating the env lookup.
 */
export function sessionsBucketName(): string {
  const name = process.env.SESSIONS_BUCKET_NAME;
  if (!name) {
    // Misconfiguration — surfaces as a failed invocation so the message retries.
    throw new Error("SESSIONS_BUCKET_NAME is not set");
  }
  return name;
}

// ---------------------------------------------------------------------------
// Per-session metadata (idempotency + activity bookkeeping)
// ---------------------------------------------------------------------------

/**
 * Metadata persisted in the session's appState. A superset of the design's
 * {@link "@mcp-events/shared".AgentSessionMetadata} that additionally tracks a
 * bounded set of processed event IDs so duplicate deliveries are rejected
 * regardless of ordering (Requirements 7.1, 7.2).
 */
export interface SessionMetadata {
  /** Most recently processed event ID. */
  lastEventId: string;
  /** ISO 8601 timestamp of the last processed event. */
  lastActiveAt: string;
  /** Number of events processed for this customer. */
  invocationCount: number;
  /** ISO 8601 — when the last briefing was generated, or null if none yet. */
  lastBriefingAt: string | null;
  /** Cached from {@link CustomerConfig.displayName}. */
  customerDisplayName: string;
  /** Rolling window of processed event IDs for idempotency checks. */
  processedEventIds: string[];
}

/** A fresh metadata record for a session that has not processed any event yet. */
function emptyMetadata(displayName: string): SessionMetadata {
  return {
    lastEventId: "",
    lastActiveAt: "",
    invocationCount: 0,
    lastBriefingAt: null,
    customerDisplayName: displayName,
    processedEventIds: [],
  };
}

/**
 * Read the session metadata from the agent's restored appState, tolerating a
 * missing or partially-shaped record (e.g. a first-ever event or a session
 * written by an earlier version). Always returns a fully-populated, safe value.
 *
 * Exported so the briefing path (task 9.8) reads/updates the same metadata
 * record without duplicating the tolerant-parsing logic.
 */
export function readMetadata(
  agent: Agent,
  displayName: string,
): SessionMetadata {
  const raw = agent.appState.get(SESSION_METADATA_KEY);
  const base = emptyMetadata(displayName);
  if (raw === null || typeof raw !== "object") {
    return base;
  }
  const candidate = raw as Partial<SessionMetadata>;
  return {
    lastEventId:
      typeof candidate.lastEventId === "string"
        ? candidate.lastEventId
        : base.lastEventId,
    lastActiveAt:
      typeof candidate.lastActiveAt === "string"
        ? candidate.lastActiveAt
        : base.lastActiveAt,
    invocationCount:
      typeof candidate.invocationCount === "number"
        ? candidate.invocationCount
        : base.invocationCount,
    lastBriefingAt:
      typeof candidate.lastBriefingAt === "string"
        ? candidate.lastBriefingAt
        : base.lastBriefingAt,
    customerDisplayName:
      typeof candidate.customerDisplayName === "string"
        ? candidate.customerDisplayName
        : base.customerDisplayName,
    processedEventIds: Array.isArray(candidate.processedEventIds)
      ? candidate.processedEventIds.filter(
          (id): id is string => typeof id === "string",
        )
      : base.processedEventIds,
  };
}

/**
 * Persist the metadata back into the agent's appState (captured on save).
 *
 * Exported so the briefing path (task 9.8) writes the same metadata record
 * (e.g. stamping `lastBriefingAt`) through one code path.
 */
export function writeMetadata(agent: Agent, metadata: SessionMetadata): void {
  agent.appState.set(SESSION_METADATA_KEY, {
    ...metadata,
  });
}

/**
 * Advance the metadata to reflect that `eventId` was processed: bump counters,
 * stamp the activity time, and append the event to the bounded
 * `processedEventIds` window (oldest entries evicted past
 * {@link PROCESSED_EVENT_IDS_LIMIT}).
 *
 * Exported so the briefing path (task 9.8) records its `briefing.trigger`
 * eventId in the same bounded idempotency window used for earthquake events.
 */
export function recordProcessedEvent(
  metadata: SessionMetadata,
  eventId: string,
  displayName: string,
): SessionMetadata {
  const processedEventIds = [...metadata.processedEventIds, eventId];
  if (processedEventIds.length > PROCESSED_EVENT_IDS_LIMIT) {
    processedEventIds.splice(
      0,
      processedEventIds.length - PROCESSED_EVENT_IDS_LIMIT,
    );
  }
  return {
    ...metadata,
    lastEventId: eventId,
    lastActiveAt: new Date().toISOString(),
    invocationCount: metadata.invocationCount + 1,
    customerDisplayName: displayName,
    processedEventIds,
  };
}

// ---------------------------------------------------------------------------
// S3 client (shared with the SDK S3Storage and the recovery path)
// ---------------------------------------------------------------------------

/** Lazily-created S3 client, reused across warm invocations. */
let s3Client: S3Client | undefined;

/**
 * Return the shared {@link S3Client}, creating it on first use.
 *
 * Exported so the corrupted-session recovery path (task 9.10) archives the
 * corrupt object through the same client (and therefore the same
 * {@link setS3ClientForTesting} test seam) the agent's storage uses.
 */
export function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({});
  }
  return s3Client;
}

/**
 * The S3 object key holding a customer's mutable "latest" session snapshot,
 * as written by the SDK's {@link S3Storage}:
 * `sessions/{customerId}/scopes/agent/agent/snapshots/snapshot_latest.json`.
 *
 * The layout is composed from {@link SESSION_SNAPSHOT_PREFIX} (the storage
 * `prefix`), the `sessionId` (= customerId), the SDK's fixed `scope` segment
 * (`agent`), {@link AGENT_SCOPE_ID} (the agent's default id), and the SDK's
 * fixed `snapshots/snapshot_latest.json` suffix — expressed once here so the
 * key never drifts from what the SDK actually writes. This is the canonical
 * session file the Data API session reader (task 4.6) and the corrupted-session
 * recovery path (task 9.10) inspect and archive.
 */
export function sessionSnapshotKey(customerId: string): string {
  return `${SESSION_SNAPSHOT_PREFIX}/${customerId}/scopes/agent/${AGENT_SCOPE_ID}/snapshots/snapshot_latest.json`;
}

/**
 * Override the S3 client. Test seam only — production code never calls this.
 * Pass `undefined` to reset back to the lazily-created client.
 */
export function setS3ClientForTesting(client: S3Client | undefined): void {
  s3Client = client;
}

/** True when an S3 error represents a missing object/bucket or a 404 response. */
export function isNotFoundError(error: unknown): boolean {
  if (error === null || typeof error !== "object") {
    return false;
  }
  const candidate = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  if (
    typeof candidate.name === "string" &&
    (candidate.name === "NoSuchKey" || candidate.name === "NoSuchBucket")
  ) {
    return true;
  }
  return candidate.$metadata?.httpStatusCode === 404;
}

// ---------------------------------------------------------------------------
// Model (test seam)
// ---------------------------------------------------------------------------

/** Module-level model override for tests. */
let modelOverride: Model | undefined;

/**
 * Override the LLM model. Test seam only — production code never calls this.
 * Pass `undefined` to reset back to the default {@link BedrockModel}.
 */
export function setModelForTesting(model: Model | undefined): void {
  modelOverride = model;
}

/** Resolve the model to use: the test override, or a default {@link BedrockModel}. */
function resolveModel(): Model {
  if (modelOverride) {
    return modelOverride;
  }
  const modelId = process.env.BEDROCK_MODEL_ID ?? DEFAULT_BEDROCK_MODEL_ID;
  return new BedrockModel({
    modelId,
    // Bedrock returns transient server-side 5xx at a low but steady rate
    // (~0.9% of invocations in this account). The AWS SDK default of 3 attempts
    // fires all of them inside about a second, which is too fast to ride out an
    // InternalServerException that persists a few seconds — three such errors
    // escaped to the agent over two weeks, each costing a 300s SQS redelivery
    // and (because the queue is FIFO) blocking that customer's message group
    // for those 5 minutes.
    //
    // Budget: `standard` mode uses a 50ms base with full jitter and a 20s cap,
    // and the cap is not reached until the 11th attempt — so 10 attempts is at
    // most ~25.5s of backoff (~13s on average), which fits inside the 90s
    // withTimeout guards around agent.invoke(). `standard` also carries a retry
    // quota, so a sustained Bedrock outage cannot turn into a retry storm.
    clientConfig: { retryMode: "standard", maxAttempts: 10 },
  });
}

// ---------------------------------------------------------------------------
// Agent construction
// ---------------------------------------------------------------------------

/** Options for {@link buildAgent}. */
export interface BuildAgentOptions {
  /**
   * Tools to register on the agent. The earthquake path (task 9.4) passes
   * none; the briefing path (task 9.8) passes the `save_report` tool so the
   * LLM can persist its synthesized report.
   */
  tools?: ToolList;
  /**
   * Conversation manager controlling history retention. Defaults to the SDK's
   * sliding-window manager (the earthquake path's behavior). The briefing path
   * passes a {@link NullConversationManager} so the LLM sees **all** prior
   * earthquake observations when synthesizing the report (Requirement 11.1)
   * rather than a truncated window.
   */
  conversationManager?: ConversationManager;
}

/**
 * Build a Strands {@link Agent} for a customer, wired to persist its session at
 * the SDK snapshot key
 * `sessions/{customerId}/scopes/agent/agent/snapshots/snapshot_latest.json` via
 * the SDK's official {@link S3Storage}. The customer's `briefingPrompt` is used
 * as the system prompt (it guides both earthquake analysis and, later, briefing
 * synthesis — Requirement 11.2).
 *
 * @param customerId    the customer whose session to bind (sessionId).
 * @param systemPrompt  the customer's `briefingPrompt`.
 * @param options       optional tools / conversation manager (see
 *   {@link BuildAgentOptions}).
 */
export function buildAgent(
  customerId: string,
  systemPrompt: string,
  options: BuildAgentOptions = {},
): Agent {
  const sessionManager = new SessionManager({
    sessionId: customerId,
    storage: {
      snapshot: new S3Storage({
        bucket: sessionsBucketName(),
        prefix: SESSION_SNAPSHOT_PREFIX,
        // Pass the shared client (not `region`) so the setS3ClientForTesting
        // seam reaches the SDK storage; the two config options are mutually
        // exclusive in the SDK.
        s3Client: getS3Client(),
      }),
    },
    // Disable auto-save: we persist explicitly after a successful LLM
    // invocation (see processEarthquakeEvent). This gives deterministic
    // persist-on-success semantics so a failed invocation leaves the session
    // untouched and the SQS message can safely retry (Requirement 15.2).
    saveLatestOn: "trigger",
  });

  return new Agent({
    model: resolveModel(),
    systemPrompt,
    sessionManager,
    ...(options.tools !== undefined && { tools: options.tools }),
    conversationManager:
      options.conversationManager ??
      new SlidingWindowConversationManager({
        windowSize: CONVERSATION_WINDOW_SIZE,
      }),
    // The agent runs headless in Lambda; no console output.
    printer: false,
  });
}

// ---------------------------------------------------------------------------
// Earthquake user-message formatting
// ---------------------------------------------------------------------------

/**
 * Leading line of an earthquake observation user message. Exported so the
 * briefing path (task 9.8) can recognize earthquake observations already in the
 * conversation history (to count them for the report and to guard against
 * generating an empty briefing) without re-implementing the format.
 */
export const EARTHQUAKE_MESSAGE_PREFIX = "A new earthquake has been detected:";

/**
 * Render an {@link EarthquakeDetectedData} payload as a human-readable user
 * message for the LLM. The message states the new earthquake's salient facts
 * and asks for a brief in-context analysis, so the assistant's response (and
 * thus the growing conversation history) accumulates per-quake analysis the
 * later briefing can synthesize (Requirement 4.4).
 */
export function formatEarthquakeUserMessage(
  data: EarthquakeDetectedData,
): string {
  const { coordinates } = data;
  const felt = data.felt === null ? "no reports" : `${data.felt} reports`;
  const alert = data.alert ?? "none";
  return [
    EARTHQUAKE_MESSAGE_PREFIX,
    `- ID: ${data.earthquakeId}`,
    `- Magnitude: ${data.magnitude}`,
    `- Location: ${data.place}`,
    `- Time: ${data.time}`,
    `- Coordinates: ${coordinates.latitude}, ${coordinates.longitude}`,
    `- Depth: ${coordinates.depth} km`,
    `- Tsunami warning: ${data.tsunami ? "yes" : "no"}`,
    `- Felt: ${felt}`,
    `- PAGER alert level: ${alert}`,
    `- More info: ${data.url}`,
    "",
    "Briefly analyze this earthquake's significance and how it relates to any earlier earthquakes in our conversation.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Earthquake event processing
// ---------------------------------------------------------------------------

/** Input for {@link processEarthquakeEvent}. */
export interface EarthquakeEventContext {
  /** Customer resolved from the subscription (see `router.ts`). */
  customerId: string;
  /** Customer configuration loaded from the Data API (briefingPrompt, etc.). */
  config: CustomerConfig;
  /** The validated `earthquake.detected` MCP event payload. */
  event: McpEventPayload<EarthquakeDetectedData>;
}

/** Outcome of processing a single earthquake event. */
export type EarthquakeProcessingResult =
  | {
      /** The event was analyzed by the LLM and the session persisted. */
      status: "processed";
      customerId: string;
      eventId: string;
      /** The assistant's analysis text. */
      analysis: string;
    }
  | {
      /** The event was a duplicate; processing skipped (Requirements 7.1, 7.2). */
      status: "skipped";
      customerId: string;
      eventId: string;
    };

/**
 * Process an `earthquake.detected` event for a customer (Requirements 4.4,
 * 7.1, 7.2).
 *
 * Flow:
 * 1. Build the customer's agent and restore its session from S3 (via
 *    `agent.initialize()`, which fires the SessionManager's restore hook).
 * 2. Re-apply the current `briefingPrompt` as the system prompt so a config
 *    update takes effect even though the restored snapshot carries the prior
 *    prompt.
 * 3. **Idempotency check** — if `eventId` is already recorded in the session
 *    metadata, skip and return `{ status: "skipped" }` without mutating the
 *    session (Requirement 7.1) so a redelivered event never adds a duplicate
 *    user message (Requirement 7.2).
 * 4. Record the event in the metadata, inject the earthquake as a user message,
 *    and invoke the LLM. After the invocation succeeds, the updated
 *    conversation history + metadata are saved to the SDK snapshot key
 *    `sessions/{customerId}/scopes/agent/agent/snapshots/snapshot_latest.json`
 *    (Requirement 4.4).
 *
 * This function assumes the caller already holds the per-customer distributed
 * lock (task 9.1 / handler task 9.10), so the read-modify-write of the session
 * is serialized.
 *
 * @throws when session restore or the LLM invocation fails; the caller lets the
 *   SQS message return to the queue for retry. Because nothing is persisted on
 *   the failure path, the retry safely reprocesses the event.
 */
export async function processEarthquakeEvent(
  ctx: EarthquakeEventContext,
): Promise<EarthquakeProcessingResult> {
  const { customerId, config, event } = ctx;

  const agent = buildAgent(customerId, config.briefingPrompt);

  // Restore the prior session (conversation history + metadata) from S3 before
  // any decision is made (Requirement 4.3). initialize() is idempotent and is
  // also called by invoke(), but we need the restored state up front for the
  // idempotency check below.
  await agent.initialize();

  // The restored snapshot carries the system prompt that was in effect when it
  // was written; re-apply the current briefingPrompt so config updates take
  // effect immediately and are persisted on the next save (Requirement 11.2).
  agent.systemPrompt = config.briefingPrompt;

  const metadata = readMetadata(agent, config.displayName);

  // Idempotency: a duplicate delivery of an already-processed event is a no-op
  // that returns success, leaving the conversation history untouched
  // (Requirements 7.1, 7.2).
  if (metadata.processedEventIds.includes(event.eventId)) {
    return { status: "skipped", customerId, eventId: event.eventId };
  }

  // Record the event in the metadata BEFORE invoking the LLM so the snapshot
  // auto-saved after the invocation captures the updated idempotency window.
  writeMetadata(
    agent,
    recordProcessedEvent(metadata, event.eventId, config.displayName),
  );

  // Inject the earthquake as a user message and invoke the LLM. The agent
  // appends both the user message and the assistant's analysis to the
  // conversation history.
  const userMessage = formatEarthquakeUserMessage(event.data);
  const result = await withTimeout(
    agent.invoke(userMessage),
    90_000,
    `Bedrock invoke timed out for customer ${customerId}`,
  );

  // Persist the updated conversation history + metadata to the SDK snapshot
  // key sessions/{customerId}/scopes/agent/agent/snapshots/snapshot_latest.json
  // only after a successful invocation (Requirement 4.4). Auto-save is disabled
  // (saveLatestOn: 'trigger'), so a failed invocation above leaves the session
  // untouched and the SQS message can retry without double-recording the event.
  if (agent.sessionManager) {
    await agent.sessionManager.saveSnapshot({ target: agent, isLatest: true });
  }

  return {
    status: "processed",
    customerId,
    eventId: event.eventId,
    analysis: result.toString(),
  };
}
