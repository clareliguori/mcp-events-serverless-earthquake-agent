/**
 * Scheduled subscription refresh for the Subscription Manager (task 10.2).
 *
 * The Subscription Manager's EventBridge trigger (every 5 minutes) runs this
 * logic to keep every active customer's webhook subscriptions alive before they
 * expire (Requirements 8.2, 8.4, 8.5, 15.3). For each active customer it:
 *
 * 1. Identifies the subscriptions expiring within a threshold window and
 *    refreshes them via the MCP `events/subscribe` method on the appropriate
 *    server (MCP Server 1 for `earthquake.detected`, MCP Server 2 for
 *    `briefing.trigger`).
 * 2. Optionally rotates the per-subscription Standard Webhooks `whsec_` secret
 *    by generating a fresh value (CSPRNG) and supplying it in `delivery.secret`
 *    on the refresh; otherwise it re-supplies the subscription's existing
 *    secret (the MCP Events protocol requires `delivery.secret` on every
 *    `events/subscribe`).
 * 3. Persists the refreshed subscription record via the Data API with the new
 *    `expiresAt`/`lastRefreshedAt` (and the rotated secret, if any).
 * 4. Detects and re-creates any required subscription that is missing for an
 *    active customer (Requirements 8.5, 15.3).
 * 5. Logs failures at per-customer granularity and continues with the next
 *    customer so one customer's failure cannot stall the whole run
 *    (Requirements 8.4, 18.3).
 *
 * Secret handling (Requirement 17.9): the Subscription Manager generates and
 * owns the per-subscription secret but holds NO KMS permissions. The plaintext
 * `whsec_` travels only in `delivery.secret` (to the MCP server, over IAM-authed
 * HTTPS) and to the Data API in the `secret` field, which the Data API
 * client-side encrypts at its storage boundary. This module therefore never
 * touches KMS — it exchanges plaintext `whsec_` with the Data API.
 *
 * The MCP server's `events/subscribe` mints a fresh `subscriptionId` on every
 * call (it does not mutate an existing record), so a refresh can return either
 * the same id (when re-subscribing in place) or a new one. This module is
 * robust to both: it writes the record under whichever `subscriptionId` the
 * server returned, updating in place when unchanged and creating a superseding
 * record when changed (the stale record then lapses via its own TTL).
 *
 * Testability: all I/O (enumerating customers, calling the MCP servers, and
 * reading/writing subscription records via the Data API) is injected through
 * the {@link RefreshDependencies} seam so the orchestration and the pure
 * expiry/missing-detection helpers can be unit-tested without SigV4 signing or
 * network/AWS access. {@link createDefaultRefreshDependencies} wires the real
 * implementations; production code never calls {@link setRefreshDependenciesForTesting}.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientWithSigV4Transport } from "@aws/run-mcp-servers-with-aws-lambda";
import type {
  CustomerConfig,
  SubscribeParams,
  SubscribeResult,
  SubscriptionParams,
  WebhookSubscription,
} from "@mcp-events/shared";
import {
  DEFAULT_SUBSCRIPTION_TTL_SECONDS,
  EVENT_NAME_BRIEFING_TRIGGER,
  EVENT_NAME_EARTHQUAKE_DETECTED,
  SUBSCRIPTION_REFRESH_THRESHOLD_SECONDS,
  generateWebhookSecret,
  subscribeResultSchema,
} from "@mcp-events/shared";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** The MCP event names a customer must be subscribed to, one per server. */
export type RefreshableEventName =
  | typeof EVENT_NAME_EARTHQUAKE_DETECTED
  | typeof EVENT_NAME_BRIEFING_TRIGGER;

/**
 * A subscription record as the Data API returns it: the stored
 * {@link WebhookSubscription} with the opaque `encryptedSecret` replaced by the
 * decrypted plaintext `secret` (`whsec_`). The Data API decrypts on read, so
 * the Subscription Manager always works with plaintext secrets in memory
 * (Requirement 17.9).
 */
export type SubscriptionRecord = Omit<
  WebhookSubscription,
  "encryptedSecret"
> & {
  /** Plaintext Standard Webhooks signing secret (`whsec_`). */
  secret: string;
};

/**
 * An active customer paired with their current subscriptions, as enumerated
 * from the Data API at the start of a refresh run.
 */
export interface ActiveCustomer {
  config: CustomerConfig;
  subscriptions: SubscriptionRecord[];
}

/**
 * Per-server descriptor: the event name a server emits and the customer-derived
 * `inputSchema` to send on `events/subscribe`. The concrete MCP endpoint URL is
 * resolved by the dependency layer (env vars), keeping this pure.
 */
export interface ServerDescriptor {
  /** The MCP event this server emits. */
  eventName: RefreshableEventName;
  /** Which MCP server this maps to (used by the dependency layer to pick a URL). */
  server: "usgs" | "scheduler";
}

/** MCP Server 1 — USGS earthquake feed (`earthquake.detected`). */
export const USGS_SERVER: ServerDescriptor = {
  eventName: EVENT_NAME_EARTHQUAKE_DETECTED,
  server: "usgs",
};

/** MCP Server 2 — message scheduler (`briefing.trigger`). */
export const SCHEDULER_SERVER: ServerDescriptor = {
  eventName: EVENT_NAME_BRIEFING_TRIGGER,
  server: "scheduler",
};

/** Every server an active customer must hold a subscription on. */
export const REQUIRED_SERVERS: readonly ServerDescriptor[] = [
  USGS_SERVER,
  SCHEDULER_SERVER,
];

/** Resolve the {@link ServerDescriptor} for an event name. */
export function serverForEventName(
  eventName: RefreshableEventName,
): ServerDescriptor {
  return eventName === EVENT_NAME_EARTHQUAKE_DETECTED
    ? USGS_SERVER
    : SCHEDULER_SERVER;
}

// ---------------------------------------------------------------------------
// Pure helpers: expiry + missing-subscription detection
// ---------------------------------------------------------------------------

/**
 * Whether a subscription is expiring within `thresholdSeconds` of `nowMs` (or is
 * already expired). A non-parseable `expiresAt` is treated as expiring so the
 * refresh run heals a malformed record rather than skipping it.
 *
 * @param subscription - The subscription to test.
 * @param nowMs - The reference time in epoch milliseconds.
 * @param thresholdSeconds - The look-ahead window in seconds.
 */
export function isExpiringWithin(
  subscription: Pick<SubscriptionRecord, "expiresAt">,
  nowMs: number,
  thresholdSeconds: number = SUBSCRIPTION_REFRESH_THRESHOLD_SECONDS,
): boolean {
  const expiresAtMs = Date.parse(subscription.expiresAt);
  if (Number.isNaN(expiresAtMs)) {
    return true;
  }
  return expiresAtMs - nowMs <= thresholdSeconds * 1000;
}

/**
 * Select the subscriptions expiring within the threshold window (Requirement
 * 8.2). Pure over its inputs so it can be property-tested in task 10.3.
 */
export function findExpiringSubscriptions(
  subscriptions: readonly SubscriptionRecord[],
  nowMs: number,
  thresholdSeconds: number = SUBSCRIPTION_REFRESH_THRESHOLD_SECONDS,
): SubscriptionRecord[] {
  return subscriptions.filter((s) =>
    isExpiringWithin(s, nowMs, thresholdSeconds),
  );
}

/**
 * Determine which required servers a customer has NO subscription for
 * (Requirements 8.5, 15.3). Only `active`/`expired`/`failed` records that exist
 * count as present; a server with no record at all is reported as missing so the
 * caller can re-create it. Pure over its inputs.
 */
export function findMissingServers(
  subscriptions: readonly SubscriptionRecord[],
): ServerDescriptor[] {
  const present = new Set(subscriptions.map((s) => s.eventName));
  return REQUIRED_SERVERS.filter((server) => !present.has(server.eventName));
}

/**
 * Build the per-customer `inputSchema` for an `events/subscribe` on a given
 * server: the earthquake filter params for MCP Server 1, or the cron schedule
 * for MCP Server 2. Undefined dimensions are dropped so an all-empty filter
 * becomes "deliver everything".
 */
export function buildInputSchema(
  server: ServerDescriptor,
  config: CustomerConfig,
): SubscribeParams["inputSchema"] {
  if (server.eventName === EVENT_NAME_BRIEFING_TRIGGER) {
    return { intervalHours: config.briefingSchedule };
  }
  const params: SubscriptionParams = config.subscriptionParams ?? {};
  const inputSchema: NonNullable<SubscribeParams["inputSchema"]> = {};
  if (params.minMagnitude !== undefined) {
    inputSchema.minMagnitude = params.minMagnitude;
  }
  if (params.region !== undefined) {
    inputSchema.region = params.region;
  }
  if (params.maxDepthKm !== undefined) {
    inputSchema.maxDepthKm = params.maxDepthKm;
  }
  return inputSchema;
}

// ---------------------------------------------------------------------------
// Dependency seam
// ---------------------------------------------------------------------------

/** Parameters for a single MCP `events/subscribe` refresh / create call. */
export interface SubscribeOnServerInputs {
  /** Which MCP server to call. */
  server: ServerDescriptor;
  /** The webhook callback URL to register for delivery. */
  callbackUrl: string;
  /** The per-subscription `whsec_` secret to supply in `delivery.secret`. */
  secret: string;
  /** The customer this subscription belongs to. */
  customerId: string;
  /** Per-customer filter / schedule parameters. */
  inputSchema: SubscribeParams["inputSchema"];
  /** Subscription TTL in seconds. */
  ttlSeconds: number;
}

/** Fields the Data API accepts when updating a subscription record (PUT). */
export interface SubscriptionRecordUpdate {
  expiresAt: string;
  lastRefreshedAt: string;
  status: WebhookSubscription["status"];
  /** Present only when the secret was rotated this refresh. */
  secret?: string;
}

/**
 * The I/O the refresh orchestration depends on. Injected so the orchestration
 * can be unit-tested with in-memory fakes (no SigV4 / network / AWS).
 */
export interface RefreshDependencies {
  /** Enumerate active customers and their current subscriptions via the Data API. */
  listActiveCustomers: () => Promise<ActiveCustomer[]>;
  /** Call MCP `events/subscribe` on the appropriate server (create or refresh). */
  subscribeOnServer: (
    inputs: SubscribeOnServerInputs,
  ) => Promise<SubscribeResult>;
  /**
   * Persist a refreshed record via the Data API. When the server returned the
   * same `subscriptionId`, the existing record is updated in place (PUT). When a
   * new `subscriptionId` was returned, a superseding record is created (POST).
   */
  upsertSubscriptionRecord: (record: SubscriptionRecord) => Promise<void>;
  /** Resolve the webhook callback URL for newly-created (missing) subscriptions. */
  resolveCallbackUrl: () => string;
}

let dependencies: RefreshDependencies | undefined;

/**
 * Override the refresh {@link RefreshDependencies}. Test seam only — production
 * code never calls this. Pass `undefined` to reset to the lazily-created
 * defaults from {@link createDefaultRefreshDependencies}.
 */
export function setRefreshDependenciesForTesting(
  override: RefreshDependencies | undefined,
): void {
  dependencies = override;
}

/** Return the active {@link RefreshDependencies}, creating the defaults on first use. */
function getDependencies(): RefreshDependencies {
  if (!dependencies) {
    dependencies = createDefaultRefreshDependencies();
  }
  return dependencies;
}

// ---------------------------------------------------------------------------
// Options + result types
// ---------------------------------------------------------------------------

/** Options controlling a refresh run. */
export interface RefreshOptions {
  /** Reference time (defaults to now). */
  now?: Date;
  /** Expiry look-ahead window (defaults to {@link SUBSCRIPTION_REFRESH_THRESHOLD_SECONDS}). */
  thresholdSeconds?: number;
  /** New-subscription TTL (defaults to {@link DEFAULT_SUBSCRIPTION_TTL_SECONDS}). */
  ttlSeconds?: number;
  /** Rotate the per-subscription secret on refresh (defaults to `false`). */
  rotateSecret?: boolean;
}

/** Why/what happened to a single subscription during a refresh run. */
export interface SubscriptionRefreshOutcome {
  customerId: string;
  eventName: RefreshableEventName;
  /** `refreshed` (existing), `recreated` (was missing), or `failed`. */
  action: "refreshed" | "recreated" | "failed";
  /** The resulting subscription id (absent when the action failed). */
  subscriptionId?: string;
  /** The new expiry (absent when the action failed). */
  expiresAt?: string;
  /** Whether the secret was rotated. */
  rotated?: boolean;
  /** Failure detail when `action === "failed"`. */
  error?: string;
}

/** Aggregate result of a refresh run. */
export interface RefreshSummary {
  customersProcessed: number;
  refreshed: number;
  recreated: number;
  failed: number;
  outcomes: SubscriptionRefreshOutcome[];
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * The domain attributes persisted on a subscription record for a server: the
 * customer's earthquake filter params (MCP Server 1) or their briefing interval
 * in hours (MCP Server 2). The field belonging to the *other* server is
 * explicitly cleared so a record can never carry both.
 *
 * These are always derived from the customer's CURRENT config rather than
 * carried over from the stored record, for two reasons:
 *
 * 1. The config is the source of truth. A customer who changes their briefing
 *    interval (or their filters) must see the stored record follow, otherwise it
 *    drifts permanently out of sync with the `inputSchema` actually registered
 *    on the MCP server by {@link buildInputSchema}.
 * 2. It stops a legacy-shaped stored record from poisoning the write. Carrying
 *    these fields forward verbatim meant a record written under an older schema
 *    — for example a cron-string `schedule` from before the interval-based
 *    migration — failed the Data API's validation with a 400 on every refresh.
 *    Because {@link RefreshDependencies.upsertSubscriptionRecord} only falls
 *    back to creating on a 404, that wedged the refresh permanently: the
 *    subscription could never be re-registered, so the Webhook Receiver could
 *    not resolve the id the MCP server was delivering under and rejected every
 *    delivery with a 401.
 */
function domainFieldsFor(
  server: ServerDescriptor,
  config: CustomerConfig,
): Pick<SubscriptionRecord, "filterParams" | "schedule"> {
  return server.eventName === EVENT_NAME_EARTHQUAKE_DETECTED
    ? { filterParams: config.subscriptionParams, schedule: undefined }
    : { schedule: config.briefingSchedule, filterParams: undefined };
}

/**
 * Refresh one expiring subscription via `events/subscribe` and persist the
 * result. Re-supplies the existing secret unless `rotateSecret` is set, in which
 * case a fresh `whsec_` is generated and stored. The persisted filter/schedule
 * fields are re-derived from the customer's config (see {@link domainFieldsFor}).
 */
async function refreshOne(
  deps: RefreshDependencies,
  customer: ActiveCustomer,
  subscription: SubscriptionRecord,
  options: Required<Pick<RefreshOptions, "ttlSeconds" | "rotateSecret">> & {
    now: Date;
  },
): Promise<SubscriptionRefreshOutcome> {
  const server = serverForEventName(
    subscription.eventName as RefreshableEventName,
  );
  const rotated = options.rotateSecret;
  const secret = rotated ? generateWebhookSecret() : subscription.secret;

  const result = await deps.subscribeOnServer({
    server,
    callbackUrl: deps.resolveCallbackUrl(),
    secret,
    customerId: customer.config.customerId,
    inputSchema: buildInputSchema(server, customer.config),
    ttlSeconds: options.ttlSeconds,
  });

  const nowIso = options.now.toISOString();
  await deps.upsertSubscriptionRecord({
    ...subscription,
    ...domainFieldsFor(server, customer.config),
    subscriptionId: result.subscriptionId,
    secret,
    expiresAt: result.expiresAt,
    lastRefreshedAt: nowIso,
    status: "active",
  });

  return {
    customerId: customer.config.customerId,
    eventName: subscription.eventName as RefreshableEventName,
    action: "refreshed",
    subscriptionId: result.subscriptionId,
    expiresAt: result.expiresAt,
    rotated,
  };
}

/**
 * Re-create a missing subscription for an active customer via
 * `events/subscribe`: generate a fresh secret, subscribe, and persist a new
 * record (Requirements 8.5, 15.3).
 */
async function recreateMissing(
  deps: RefreshDependencies,
  customer: ActiveCustomer,
  server: ServerDescriptor,
  options: Required<Pick<RefreshOptions, "ttlSeconds">> & { now: Date },
): Promise<SubscriptionRefreshOutcome> {
  const secret = generateWebhookSecret();
  const callbackUrl = deps.resolveCallbackUrl();

  const result = await deps.subscribeOnServer({
    server,
    callbackUrl,
    secret,
    customerId: customer.config.customerId,
    inputSchema: buildInputSchema(server, customer.config),
    ttlSeconds: options.ttlSeconds,
  });

  const nowIso = options.now.toISOString();
  const record: SubscriptionRecord = {
    subscriptionId: result.subscriptionId,
    customerId: customer.config.customerId,
    serverEndpoint: callbackUrl,
    eventName: server.eventName,
    callbackUrl,
    secret,
    ...domainFieldsFor(server, customer.config),
    createdAt: nowIso,
    expiresAt: result.expiresAt,
    lastRefreshedAt: nowIso,
    status: "active",
  };
  await deps.upsertSubscriptionRecord(record);

  return {
    customerId: customer.config.customerId,
    eventName: server.eventName,
    action: "recreated",
    subscriptionId: result.subscriptionId,
    expiresAt: result.expiresAt,
    rotated: true,
  };
}

/**
 * Refresh all expiring subscriptions and re-create any missing ones for every
 * active customer (Requirements 8.2, 8.4, 8.5, 15.3).
 *
 * Each customer is processed independently inside its own try/catch so a single
 * customer's failure is logged with its `customerId` (Requirements 8.4, 18.3)
 * and the run continues. The summary aggregates per-subscription outcomes so the
 * handler (task 10.4) can surface counts / failures.
 *
 * @param options - Reference time, expiry threshold, TTL, and secret-rotation toggle.
 * @param deps - Injected dependencies (defaults wired by {@link createDefaultRefreshDependencies}).
 */
export async function refreshExpiringSubscriptions(
  options: RefreshOptions = {},
  deps: RefreshDependencies = getDependencies(),
): Promise<RefreshSummary> {
  const now = options.now ?? new Date();
  const thresholdSeconds =
    options.thresholdSeconds ?? SUBSCRIPTION_REFRESH_THRESHOLD_SECONDS;
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_SUBSCRIPTION_TTL_SECONDS;
  const rotateSecret = options.rotateSecret ?? false;

  const customers = await deps.listActiveCustomers();
  const outcomes: SubscriptionRefreshOutcome[] = [];

  for (const customer of customers) {
    const { customerId } = customer.config;
    try {
      const expiring = findExpiringSubscriptions(
        customer.subscriptions,
        now.getTime(),
        thresholdSeconds,
      );
      for (const subscription of expiring) {
        outcomes.push(
          await refreshSubscriptionSafely(deps, customer, subscription, {
            ttlSeconds,
            rotateSecret,
            now,
          }),
        );
      }

      const missing = findMissingServers(customer.subscriptions);
      for (const server of missing) {
        outcomes.push(
          await recreateMissingSafely(deps, customer, server, {
            ttlSeconds,
            now,
          }),
        );
      }
    } catch (error) {
      // Defensive: any unexpected per-customer error is logged with its
      // customerId and does not abort the run (Requirements 8.4, 18.3).
      console.error("Subscription refresh failed for customer", {
        customerId,
        error: errorMessage(error),
      });
      outcomes.push({
        customerId,
        eventName: EVENT_NAME_EARTHQUAKE_DETECTED,
        action: "failed",
        error: errorMessage(error),
      });
    }
  }

  return summarize(customers.length, outcomes);
}

/**
 * Refresh one subscription, converting a failure into a logged `failed` outcome
 * instead of throwing so the rest of the customer's subscriptions still run
 * (Requirement 8.4).
 */
async function refreshSubscriptionSafely(
  deps: RefreshDependencies,
  customer: ActiveCustomer,
  subscription: SubscriptionRecord,
  options: Required<Pick<RefreshOptions, "ttlSeconds" | "rotateSecret">> & {
    now: Date;
  },
): Promise<SubscriptionRefreshOutcome> {
  try {
    return await refreshOne(deps, customer, subscription, options);
  } catch (error) {
    console.error("Failed to refresh subscription", {
      customerId: customer.config.customerId,
      subscriptionId: subscription.subscriptionId,
      eventName: subscription.eventName,
      error: errorMessage(error),
    });
    return {
      customerId: customer.config.customerId,
      eventName: subscription.eventName as RefreshableEventName,
      action: "failed",
      subscriptionId: subscription.subscriptionId,
      error: errorMessage(error),
    };
  }
}

/**
 * Re-create one missing subscription, converting a failure into a logged
 * `failed` outcome instead of throwing (Requirement 8.4).
 */
async function recreateMissingSafely(
  deps: RefreshDependencies,
  customer: ActiveCustomer,
  server: ServerDescriptor,
  options: Required<Pick<RefreshOptions, "ttlSeconds">> & { now: Date },
): Promise<SubscriptionRefreshOutcome> {
  try {
    return await recreateMissing(deps, customer, server, options);
  } catch (error) {
    console.error("Failed to re-create missing subscription", {
      customerId: customer.config.customerId,
      eventName: server.eventName,
      error: errorMessage(error),
    });
    return {
      customerId: customer.config.customerId,
      eventName: server.eventName,
      action: "failed",
      error: errorMessage(error),
    };
  }
}

/** Aggregate per-subscription outcomes into a {@link RefreshSummary}. */
function summarize(
  customersProcessed: number,
  outcomes: SubscriptionRefreshOutcome[],
): RefreshSummary {
  let refreshed = 0;
  let recreated = 0;
  let failed = 0;
  for (const outcome of outcomes) {
    if (outcome.action === "refreshed") {
      refreshed += 1;
    } else if (outcome.action === "recreated") {
      recreated += 1;
    } else {
      failed += 1;
    }
  }
  return { customersProcessed, refreshed, recreated, failed, outcomes };
}

/** Extract a human-readable message from an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Default dependency implementations (SigV4 Data API + MCP client)
// ---------------------------------------------------------------------------

/** Resolve the signing region from the Lambda environment. */
function signingRegion(): string {
  return (
    process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1"
  );
}

/** Resolve a required environment variable, throwing a clear error when unset. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

/** Resolve the MCP endpoint URL for a server from the environment. */
function mcpUrlForServer(server: ServerDescriptor): string {
  return server.server === "usgs"
    ? requireEnv("USGS_MCP_URL")
    : requireEnv("SCHEDULER_MCP_URL");
}

/**
 * Build the production {@link RefreshDependencies}: enumerate customers and
 * read/write subscription records via the Data API over IAM SigV4, and call the
 * MCP servers' `events/subscribe` via {@link StreamableHTTPClientWithSigV4Transport}.
 *
 * All HTTPS to the Data API and the MCP servers is signed for `execute-api`
 * using the Lambda execution role's credentials (default provider chain). The
 * plaintext `whsec_` secret is exchanged with the Data API directly (no KMS) per
 * Requirement 17.9.
 */
export function createDefaultRefreshDependencies(): RefreshDependencies {
  return {
    listActiveCustomers: defaultListActiveCustomers,
    subscribeOnServer: defaultSubscribeOnServer,
    upsertSubscriptionRecord: defaultUpsertSubscriptionRecord,
    resolveCallbackUrl: () => `${requireEnv("WEBHOOK_URL").replace(/\/+$/, "")}/webhook`,
  };
}

/**
 * Create a SigV4-signing `fetch` for the `execute-api` service using the Lambda
 * execution role's credentials. Reused for every Data API REST call.
 */
async function dataApiFetch(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ statusCode: number; body: string }> {
  // Imported lazily so the (network/credentials) machinery is not pulled in
  // when a test injects its own dependencies.
  const { createSigV4Fetch } =
    await import("@aws/run-mcp-servers-with-aws-lambda");
  const signedFetch = createSigV4Fetch({
    service: "execute-api",
    region: signingRegion(),
  });

  const init: RequestInit = {
    method,
    headers: { accept: "application/json" },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = {
      ...(init.headers as Record<string, string>),
      "content-type": "application/json",
    };
  }

  const response = await signedFetch(url, init);
  return { statusCode: response.status, body: await response.text() };
}

/** Base Data API URL without a trailing slash. */
function dataApiBaseUrl(): string {
  return requireEnv("DATA_API_URL").replace(/\/+$/, "");
}

/**
 * Enumerate active customers and their subscriptions via the Data API. Reads the
 * customer list from `GET /customers` (the Data API's active-customer
 * enumeration surface, used by the Subscription Manager's scheduled refresh) and
 * each customer's current subscriptions from `GET /customers/{id}/subscriptions`.
 */
const defaultListActiveCustomers: RefreshDependencies["listActiveCustomers"] =
  async () => {
    const base = dataApiBaseUrl();
    const listed = await dataApiFetch("GET", `${base}/backend/customers`);
    if (listed.statusCode < 200 || listed.statusCode >= 300) {
      throw new Error(`Data API GET /backend/customers returned ${listed.statusCode}`);
    }
    const configs = parseCustomers(listed.body).filter((c) => c.active);

    const customers: ActiveCustomer[] = [];
    for (const config of configs) {
      const subsUrl = `${base}/customers/${encodeURIComponent(
        config.customerId,
      )}/subscriptions`;
      const subsResult = await dataApiFetch("GET", subsUrl);
      if (subsResult.statusCode < 200 || subsResult.statusCode >= 300) {
        throw new Error(
          `Data API GET subscriptions for ${config.customerId} returned ${subsResult.statusCode}`,
        );
      }
      customers.push({
        config,
        subscriptions: parseSubscriptions(subsResult.body),
      });
    }
    return customers;
  };

/** Parse the `{ customers: CustomerConfig[] }` body returned by `GET /customers`. */
function parseCustomers(body: string): CustomerConfig[] {
  const json = safeJson(body);
  if (
    typeof json === "object" &&
    json !== null &&
    Array.isArray((json as { customers?: unknown }).customers)
  ) {
    return (json as { customers: CustomerConfig[] }).customers;
  }
  return [];
}

/** Parse the `{ subscriptions: SubscriptionRecord[] }` body returned by the Data API. */
function parseSubscriptions(body: string): SubscriptionRecord[] {
  const json = safeJson(body);
  if (
    typeof json === "object" &&
    json !== null &&
    Array.isArray((json as { subscriptions?: unknown }).subscriptions)
  ) {
    return (json as { subscriptions: SubscriptionRecord[] }).subscriptions;
  }
  return [];
}

/** Best-effort JSON parse; returns `undefined` when the text is not JSON. */
function safeJson(text: string): unknown {
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Call MCP `events/subscribe` on the appropriate server via SigV4 over the MCP
 * HTTP transport, returning the `{ subscriptionId, expiresAt }` result.
 */
const defaultSubscribeOnServer: RefreshDependencies["subscribeOnServer"] =
  async (inputs) => {
    const url = mcpUrlForServer(inputs.server);
    const transport = new StreamableHTTPClientWithSigV4Transport(new URL(url), {
      service: "execute-api",
      region: signingRegion(),
    });
    const client = new Client(
      { name: "subscription-manager", version: "1.0.0" },
      { capabilities: {} },
    );
    await client.connect(transport);
    try {
      // Map to the MCP Events protocol wire format expected by the SDK's
      // McpServer (events/subscribe).
      const wireParams = {
        name: inputs.server.eventName,
        delivery: {
          mode: "webhook" as const,
          url: inputs.callbackUrl,
          secret: inputs.secret,
        },
        params: {
          ...(inputs.inputSchema ?? {}),
          customerId: inputs.customerId,
        },
      };
      const result = await client.request(
        {
          method: "events/subscribe",
          params: wireParams,
        },
        subscribeResultSchema,
      );
      return result;
    } finally {
      await client.close();
    }
  };

/**
 * Persist a refreshed/created subscription record via the Data API, exchanging
 * the plaintext `whsec_` secret (the Data API encrypts at its storage boundary —
 * Requirement 17.9). Updates in place with `PUT /subscriptions/{id}` and falls
 * back to `POST /customers/{customerId}/subscriptions` when the record does not
 * yet exist (a server-minted new `subscriptionId`).
 */
const defaultUpsertSubscriptionRecord: RefreshDependencies["upsertSubscriptionRecord"] =
  async (record) => {
    const base = dataApiBaseUrl();
    const putUrl = `${base}/subscriptions/${encodeURIComponent(
      record.subscriptionId,
    )}`;
    const update: SubscriptionRecordUpdate & {
      filterParams?: SubscriptionParams;
      schedule?: number;
    } = {
      expiresAt: record.expiresAt,
      lastRefreshedAt: record.lastRefreshedAt,
      status: record.status,
      secret: record.secret,
      ...(record.filterParams ? { filterParams: record.filterParams } : {}),
      ...(record.schedule ? { schedule: record.schedule } : {}),
    };

    const put = await dataApiFetch("PUT", putUrl, update);
    if (put.statusCode >= 200 && put.statusCode < 300) {
      return;
    }
    if (put.statusCode !== 404) {
      // Include the response body: the Data API returns the specific validation
      // failure there, and without it a 400 is undiagnosable from logs alone.
      throw new Error(
        `Data API PUT subscription ${record.subscriptionId} returned ` +
          `${put.statusCode}: ${truncate(put.body)}`,
      );
    }

    // The subscription id did not exist yet (server minted a new id on refresh,
    // or this is a re-created subscription) — create the record instead.
    const postUrl = `${base}/customers/${encodeURIComponent(
      record.customerId,
    )}/subscriptions`;
    const post = await dataApiFetch("POST", postUrl, record);
    if (post.statusCode < 200 || post.statusCode >= 300) {
      throw new Error(
        `Data API POST subscription for ${record.customerId} returned ` +
          `${post.statusCode}: ${truncate(post.body)}`,
      );
    }
  };

/**
 * Clamp a Data API response body to a bounded length for inclusion in an error
 * message, so a large or unexpected body cannot flood the logs.
 */
function truncate(body: string, max = 200): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  return collapsed.length <= max
    ? collapsed
    : `${collapsed.slice(0, max)}...(truncated)`;
}
