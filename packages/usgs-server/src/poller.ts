/**
 * USGS feed polling and cursor-based deduplication for MCP Server 1 (task 6.1).
 *
 * This module owns the "detect new earthquakes" half of MCP Server 1: it fetches
 * the USGS 2.5-magnitude-day GeoJSON feed, extracts each feature into the shared
 * {@link EarthquakeDetectedData} shape, and uses a single shared DynamoDB cursor
 * row to deduplicate earthquakes across poll cycles (Requirements 1.1, 1.4,
 * 1.6).
 *
 * Per-subscription filtering (task 6.3) and webhook delivery (task 6.5) live in
 * separate modules; this module deliberately stops at "which earthquakes are
 * new" plus "commit the cursor once they've been emitted" so the dedup logic
 * stays small and independently testable.
 *
 * Cursor model (see {@link UsgsCursorState} and design Model 10):
 * - A single row keyed by `cursorId` (default {@link DEFAULT_CURSOR_ID}) holds
 *   `lastSeenIds`, a rolling window of the most recently emitted earthquake IDs.
 * - `lastSeenIds` is ordered oldest-first (the most recent ID is at the end) and
 *   is bounded to {@link USGS_CURSOR_MAX_IDS} entries; older IDs fall out of the
 *   window. The 2.5_day feed only spans ~1 day and we poll every 5 minutes, so
 *   200 IDs comfortably covers everything still in the feed.
 *
 * Ordering / atomicity:
 * - {@link extractEarthquakes} sorts earthquakes chronologically (oldest first)
 *   so emission order is stable and the newest IDs always land at the end of the
 *   cursor window.
 * - {@link commitCursor} writes the whole cursor row in a single DynamoDB
 *   `PutItem`, which is atomic. It is called only AFTER the caller has finished
 *   emitting the new earthquakes (task 6.5), so a crash mid-emission leaves the
 *   cursor unchanged and the earthquakes are retried on the next poll rather
 *   than silently dropped (Requirements 1.4, 15.4). A single scheduled poller
 *   (EventBridge every 5 min) is assumed, so no optimistic-concurrency guard is
 *   needed.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  EarthquakeDetectedData,
  UsgsCursorState,
} from "@mcp-events/shared";
import { USGS_CURSOR_MAX_IDS } from "@mcp-events/shared";

/**
 * Fixed partition key for the single USGS cursor row. Matches the example value
 * in design Model 10 (`UsgsCursorState.cursorId`).
 */
export const DEFAULT_CURSOR_ID = "usgs-2.5-day";

/** PAGER alert levels recognized on USGS features. */
const ALERT_LEVELS = ["green", "yellow", "orange", "red"] as const;
type AlertLevel = (typeof ALERT_LEVELS)[number];

// ---------------------------------------------------------------------------
// USGS GeoJSON feed shapes (subset we consume)
// ---------------------------------------------------------------------------

/**
 * The relevant subset of a USGS GeoJSON `Feature`. Every field is typed as
 * `unknown`/optional because the feed is an untrusted external source; we
 * validate each field in {@link featureToEarthquake} before use.
 */
export interface UsgsFeature {
  /** USGS earthquake ID, e.g. "us7000n123". */
  id?: unknown;
  properties?: {
    /** Richter magnitude. */
    mag?: unknown;
    /** Human-readable location. */
    place?: unknown;
    /** Epoch milliseconds (number) or an ISO 8601 string. */
    time?: unknown;
    /** 1 (or truthy) when a tsunami warning was issued. */
    tsunami?: unknown;
    /** Number of "felt" reports, if any. */
    felt?: unknown;
    /** PAGER alert level. */
    alert?: unknown;
    /** USGS event page URL. */
    url?: unknown;
  } | null;
  geometry?: {
    /** `[longitude, latitude, depth]` in decimal degrees / kilometers. */
    coordinates?: unknown;
  } | null;
}

/** The relevant subset of a USGS GeoJSON `FeatureCollection`. */
export interface UsgsFeatureCollection {
  features?: UsgsFeature[];
}

/** Minimal `fetch` signature so tests can inject a stub. */
export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

// ---------------------------------------------------------------------------
// DynamoDB document client (lazy singleton + test seam)
// ---------------------------------------------------------------------------

let documentClient: DynamoDBDocumentClient | undefined;

/** Return the shared {@link DynamoDBDocumentClient}, creating it on first use. */
function getDocumentClient(): DynamoDBDocumentClient {
  if (!documentClient) {
    documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return documentClient;
}

/**
 * Override the DynamoDB document client. Test seam only — production code never
 * calls this. Pass `undefined` to reset back to the lazily-created client.
 */
export function setDocumentClientForTesting(
  client: DynamoDBDocumentClient | undefined,
): void {
  documentClient = client;
}

/** Resolve the Cursor State table name from the environment. */
function cursorTableName(): string {
  const name = process.env.CURSOR_STATE_TABLE_NAME;
  if (!name) {
    // Misconfiguration — surfaces as a 500 / failed invocation to the caller.
    throw new Error("CURSOR_STATE_TABLE_NAME is not set");
  }
  return name;
}

/** Resolve the USGS feed URL from the environment. */
function feedUrlFromEnv(): string {
  const url = process.env.USGS_FEED_URL;
  if (!url) {
    throw new Error("USGS_FEED_URL is not set");
  }
  return url;
}

// ---------------------------------------------------------------------------
// Feed fetching
// ---------------------------------------------------------------------------

/**
 * Delays (ms) between USGS feed fetch attempts. Two entries means up to three
 * attempts (1 initial + 2 retries), keeping the worst case (~1.25s of backoff
 * plus the attempts themselves) far inside the poller Lambda's 60s timeout and
 * its 5-minute schedule.
 *
 * The USGS feed is a third-party endpoint reached over the public internet, and
 * a bare single-shot `fetch` turned any transient blip — a reset connection, a
 * DNS hiccup, a 503 — into a failed poll cycle and a paging alarm, at a rate of
 * roughly one a week.
 */
export const FEED_RETRY_DELAYS_MS = [250, 1_000] as const;

/** Injectable sleep so tests never wait on real timers. */
type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

let sleepImpl: Sleep = realSleep;

/**
 * Override the retry sleep. Test seam only — production code never calls this.
 * Pass `undefined` to reset to the real timer-based sleep.
 */
export function setFeedRetrySleepForTesting(override: Sleep | undefined): void {
  sleepImpl = override ?? realSleep;
}

/**
 * Whether an HTTP status is worth retrying. 429 and 5xx are transient; other
 * 4xx responses indicate a permanent problem (typically a misconfigured
 * `USGS_FEED_URL`) that retrying would only delay surfacing.
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Fetch and JSON-parse the USGS GeoJSON feed, retrying transient failures.
 *
 * Network-level rejections and retryable statuses ({@link isRetryableStatus})
 * are retried with the {@link FEED_RETRY_DELAYS_MS} backoff. Each retry logs a
 * `WARN`, which the stack's log-error metric filter counts (it matches both
 * `ERROR` and `WARN`) — so a blip that the retry papers over is still visible
 * and still alarms, while no longer failing the poll cycle or delaying events.
 *
 * @param feedUrl  Feed URL; defaults to the `USGS_FEED_URL` environment
 *                 variable supplied by the CDK stack.
 * @param fetchImpl  `fetch` implementation; defaults to the global `fetch`
 *                 (Node 20+). Injectable for tests.
 *
 * @throws Error when a non-retryable status is returned, or when every attempt
 *   fails. The caller (the Lambda handler, task 6.5) treats a throw here as
 *   "USGS unavailable", exits without emitting, and leaves the cursor unchanged
 *   so the poll is retried next cycle (Requirement 15.4).
 */
export async function fetchUsgsFeed(
  feedUrl: string = feedUrlFromEnv(),
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<UsgsFeatureCollection> {
  const maxAttempts = FEED_RETRY_DELAYS_MS.length + 1;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let outcome:
      | { feed: UsgsFeatureCollection }
      | { error: Error; retryable: boolean };

    try {
      const response = await fetchImpl(feedUrl);
      outcome = response.ok
        ? { feed: (await response.json()) as UsgsFeatureCollection }
        : {
            error: new Error(
              `USGS feed request failed with status ${response.status}`,
            ),
            retryable: isRetryableStatus(response.status),
          };
    } catch (cause) {
      // Network-level failure (connection reset, DNS, TLS) or an unparseable
      // body — always treated as transient.
      outcome = {
        error: cause instanceof Error ? cause : new Error(String(cause)),
        retryable: true,
      };
    }

    if ("feed" in outcome) {
      return outcome.feed;
    }

    lastError = outcome.error;
    if (!outcome.retryable || attempt === maxAttempts) {
      break;
    }

    const retryInMs = FEED_RETRY_DELAYS_MS[attempt - 1];
    console.warn("USGS feed fetch failed; retrying", {
      attempt,
      maxAttempts,
      retryInMs,
      error: lastError.message,
    });
    await sleepImpl(retryInMs);
  }

  throw lastError ?? new Error("USGS feed request failed");
}

// ---------------------------------------------------------------------------
// Earthquake extraction
// ---------------------------------------------------------------------------

/** Whether `value` is a finite number. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Coerce a USGS `time` (epoch ms number or ISO string) to an ISO 8601 string. */
function toIsoTime(time: unknown): string | undefined {
  if (isFiniteNumber(time)) {
    return new Date(time).toISOString();
  }
  if (typeof time === "string") {
    const parsed = Date.parse(time);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return undefined;
}

/** Coerce a USGS `alert` to the known enum, or `null` when unrecognized. */
function toAlert(alert: unknown): AlertLevel | null {
  return typeof alert === "string" &&
    (ALERT_LEVELS as readonly string[]).includes(alert)
    ? (alert as AlertLevel)
    : null;
}

/** Coerce a USGS `felt` count to a non-negative integer, or `null`. */
function toFelt(felt: unknown): number | null {
  return isFiniteNumber(felt) ? Math.max(0, Math.trunc(felt)) : null;
}

/**
 * Convert a single USGS feature into an {@link EarthquakeDetectedData}, or
 * return `undefined` when the feature is missing the essential fields
 * (`id`, finite `mag`, numeric `[lon, lat, depth]`, parseable `time`). Optional
 * fields degrade gracefully: a missing `place` becomes an empty string, an
 * unrecognized `alert` becomes `null`, and `tsunami` is normalized to a boolean.
 */
export function featureToEarthquake(
  feature: UsgsFeature,
): EarthquakeDetectedData | undefined {
  const earthquakeId = typeof feature.id === "string" ? feature.id : undefined;
  if (!earthquakeId) {
    return undefined;
  }

  const props = feature.properties ?? {};
  if (!isFiniteNumber(props.mag)) {
    return undefined;
  }

  const coords = feature.geometry?.coordinates;
  if (
    !Array.isArray(coords) ||
    !isFiniteNumber(coords[0]) ||
    !isFiniteNumber(coords[1]) ||
    !isFiniteNumber(coords[2])
  ) {
    return undefined;
  }

  const time = toIsoTime(props.time);
  if (!time) {
    return undefined;
  }

  return {
    earthquakeId,
    magnitude: props.mag,
    place: typeof props.place === "string" ? props.place : "",
    coordinates: {
      longitude: coords[0],
      latitude: coords[1],
      depth: coords[2],
    },
    time,
    tsunami: Boolean(props.tsunami),
    felt: toFelt(props.felt),
    alert: toAlert(props.alert),
    url: typeof props.url === "string" ? props.url : "",
  };
}

/**
 * Extract every usable earthquake from a USGS feed, sorted chronologically
 * (oldest first, tie-broken by `earthquakeId` for determinism). Features that
 * cannot be parsed into the essential fields are skipped rather than failing the
 * whole poll.
 */
export function extractEarthquakes(
  feed: UsgsFeatureCollection,
): EarthquakeDetectedData[] {
  const features = Array.isArray(feed.features) ? feed.features : [];
  const earthquakes: EarthquakeDetectedData[] = [];
  for (const feature of features) {
    const earthquake = featureToEarthquake(feature);
    if (earthquake) {
      earthquakes.push(earthquake);
    }
  }
  return earthquakes.sort((a, b) => {
    const byTime = Date.parse(a.time) - Date.parse(b.time);
    return byTime !== 0 ? byTime : a.earthquakeId.localeCompare(b.earthquakeId);
  });
}

// ---------------------------------------------------------------------------
// Cursor comparison & rolling-window bounding
// ---------------------------------------------------------------------------

/**
 * Return only the earthquakes whose IDs are NOT already in the cursor's
 * `lastSeenIds`, preserving the (chronological) input order. These are the
 * earthquakes the poll cycle should emit (Requirements 1.1, 1.6).
 */
export function findNewEarthquakes(
  earthquakes: readonly EarthquakeDetectedData[],
  lastSeenIds: readonly string[],
): EarthquakeDetectedData[] {
  const seen = new Set(lastSeenIds);
  return earthquakes.filter((q) => !seen.has(q.earthquakeId));
}

/**
 * Merge newly emitted earthquake IDs into the existing rolling window.
 *
 * Any existing ID that reappears in `newlySeenIds` is moved to the most-recent
 * end (so it survives trimming), the lists are concatenated oldest-first, and
 * the result is bounded to `maxIds` by dropping the oldest entries from the
 * front. With `lastSeenIds` ordered oldest-first, this keeps the most recent
 * IDs — exactly what the next poll needs to deduplicate against.
 */
export function mergeLastSeenIds(
  existing: readonly string[],
  newlySeenIds: readonly string[],
  maxIds: number = USGS_CURSOR_MAX_IDS,
): string[] {
  // De-duplicate the incoming batch while preserving its order.
  const incoming: string[] = [];
  const incomingSet = new Set<string>();
  for (const id of newlySeenIds) {
    if (!incomingSet.has(id)) {
      incomingSet.add(id);
      incoming.push(id);
    }
  }

  // Keep prior IDs not superseded by the incoming batch, then append the batch.
  const retained = existing.filter((id) => !incomingSet.has(id));
  const combined = [...retained, ...incoming];

  // Bound to the rolling window, keeping the most recent (tail) entries.
  return maxIds > 0 && combined.length > maxIds
    ? combined.slice(combined.length - maxIds)
    : combined;
}

// ---------------------------------------------------------------------------
// Cursor persistence
// ---------------------------------------------------------------------------

/**
 * Read the shared USGS cursor row from DynamoDB. Returns `undefined` on the very
 * first poll (no row yet), which the caller treats as an empty `lastSeenIds`.
 */
export async function readCursorState(
  cursorId: string = DEFAULT_CURSOR_ID,
): Promise<UsgsCursorState | undefined> {
  const result = await getDocumentClient().send(
    new GetCommand({
      TableName: cursorTableName(),
      Key: { cursorId },
    }),
  );
  return result.Item as UsgsCursorState | undefined;
}

/** Parameters for {@link commitCursor}. */
export interface CommitCursorParams {
  /** Cursor partition key; defaults to {@link DEFAULT_CURSOR_ID}. */
  cursorId?: string;
  /**
   * The cursor row read at the start of this poll (via {@link readCursorState}),
   * or `undefined` on the first ever poll. Supplies the prior `lastSeenIds` and
   * `totalEmitted`.
   */
  previous?: UsgsCursorState;
  /**
   * IDs of the earthquakes emitted this cycle, in chronological (oldest-first)
   * order. Folded into the rolling window and used to bump `totalEmitted`.
   */
  newlySeenIds: readonly string[];
  /** Poll timestamp (ISO 8601); defaults to the current time. */
  pollAt?: string;
  /** Rolling-window bound; defaults to {@link USGS_CURSOR_MAX_IDS}. */
  maxIds?: number;
}

/**
 * Persist the updated cursor in a single atomic DynamoDB `PutItem`
 * (Requirement 1.4). Call this only AFTER the new earthquakes have been emitted
 * so the cursor advances exactly once per successful emission.
 *
 * Returns the cursor state that was written.
 */
export async function commitCursor(
  params: CommitCursorParams,
): Promise<UsgsCursorState> {
  const cursorId = params.cursorId ?? DEFAULT_CURSOR_ID;
  const now = params.pollAt ?? new Date().toISOString();
  const emittedThisCycle = params.newlySeenIds.length;

  const lastSeenIds = mergeLastSeenIds(
    params.previous?.lastSeenIds ?? [],
    params.newlySeenIds,
    params.maxIds ?? USGS_CURSOR_MAX_IDS,
  );

  const next: UsgsCursorState = {
    cursorId,
    lastSeenIds,
    lastPollAt: now,
    // Only advance lastEmittedAt when something was actually emitted; otherwise
    // carry the prior value forward (or fall back to this poll on first run).
    lastEmittedAt:
      emittedThisCycle > 0 ? now : (params.previous?.lastEmittedAt ?? now),
    totalEmitted: (params.previous?.totalEmitted ?? 0) + emittedThisCycle,
  };

  await getDocumentClient().send(
    new PutCommand({
      TableName: cursorTableName(),
      Item: next,
    }),
  );

  return next;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Result of {@link detectNewEarthquakes}. */
export interface DetectionResult {
  /** New earthquakes to emit this cycle (chronological, oldest first). */
  newEarthquakes: EarthquakeDetectedData[];
  /** Every earthquake extracted from the feed (for diagnostics/metrics). */
  allEarthquakes: EarthquakeDetectedData[];
  /** The cursor row read at the start of the poll (undefined on first run). */
  cursor: UsgsCursorState | undefined;
}

/**
 * Fetch the feed, extract earthquakes, read the cursor, and compute which
 * earthquakes are new. Does NOT write the cursor — the caller emits the new
 * earthquakes first (tasks 6.3/6.5), then calls {@link commitCursor} so the
 * cursor only advances after a successful emission (Requirement 1.4).
 */
export async function detectNewEarthquakes(options?: {
  feedUrl?: string;
  fetchImpl?: FetchLike;
  cursorId?: string;
}): Promise<DetectionResult> {
  const cursorId = options?.cursorId ?? DEFAULT_CURSOR_ID;
  const [feed, cursor] = await Promise.all([
    fetchUsgsFeed(options?.feedUrl, options?.fetchImpl),
    readCursorState(cursorId),
  ]);

  const allEarthquakes = extractEarthquakes(feed);
  const newEarthquakes = findNewEarthquakes(
    allEarthquakes,
    cursor?.lastSeenIds ?? [],
  );

  return { newEarthquakes, allEarthquakes, cursor };
}
