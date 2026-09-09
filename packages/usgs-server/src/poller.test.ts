/**
 * Unit tests for the USGS feed poller and cursor-based deduplication (task 6.1).
 *
 * The DynamoDB document client is mocked with `aws-sdk-client-mock` so the tests
 * exercise the real cursor logic (read, compare, bound, write) without touching
 * AWS, and `fetch` is stubbed so feed parsing is exercised offline. Covered:
 * - fetchUsgsFeed success + non-2xx -> throw,
 * - featureToEarthquake field mapping + rejection of malformed features,
 * - extractEarthquakes chronological ordering + skipping bad features,
 * - findNewEarthquakes dedup against lastSeenIds,
 * - mergeLastSeenIds rolling-window bounding to 200 (keeps most recent),
 * - readCursorState found / first-run,
 * - commitCursor atomic single PutItem, advances totals + window,
 * - detectNewEarthquakes end-to-end against overlapping poll cycles.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import type { UsgsCursorState } from "@mcp-events/shared";
import { USGS_CURSOR_MAX_IDS } from "@mcp-events/shared";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type FetchLike,
  type UsgsFeature,
  type UsgsFeatureCollection,
  DEFAULT_CURSOR_ID,
  FEED_RETRY_DELAYS_MS,
  commitCursor,
  detectNewEarthquakes,
  extractEarthquakes,
  featureToEarthquake,
  fetchUsgsFeed,
  findNewEarthquakes,
  mergeLastSeenIds,
  readCursorState,
  setDocumentClientForTesting,
  setFeedRetrySleepForTesting,
} from "./poller.js";

const TABLE_NAME = "test-cursor-state";

const ddbMock = mockClient(DynamoDBDocumentClient);

interface FeatureOverrides {
  id?: unknown;
  mag?: unknown;
  place?: unknown;
  time?: unknown;
  tsunami?: unknown;
  felt?: unknown;
  alert?: unknown;
  url?: unknown;
  coordinates?: unknown;
}

/**
 * Build a USGS GeoJSON feature with sensible defaults. A default applies only
 * when the override key is ABSENT — passing an explicit `undefined`/`null`/falsy
 * value (e.g. `{ mag: null }`) is honored so tests can exercise malformed
 * features. (A `??` fallback would silently replace those, masking the case.)
 */
function makeFeature(overrides: FeatureOverrides = {}): UsgsFeature {
  const pick = <K extends keyof FeatureOverrides>(
    key: K,
    fallback: unknown,
  ): unknown => (key in overrides ? overrides[key] : fallback);

  return {
    id: pick("id", "us7000abcd"),
    properties: {
      mag: pick("mag", 4.2),
      place: pick("place", "10km SW of Ridgecrest, CA"),
      time: pick("time", 1_700_000_000_000),
      tsunami: pick("tsunami", 0),
      felt: pick("felt", null),
      alert: pick("alert", null),
      url: pick(
        "url",
        "https://earthquake.usgs.gov/earthquakes/eventpage/us7000abcd",
      ),
    },
    geometry: {
      coordinates: pick("coordinates", [-117.6, 35.6, 8.3]),
    },
  };
}

/** Build a stub `fetch` returning the given feed JSON with a 200 status. */
function stubFetch(feed: UsgsFeatureCollection): FetchLike {
  return () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(feed),
    });
}

beforeEach(() => {
  ddbMock.reset();
  setDocumentClientForTesting(
    DynamoDBDocumentClient.from(new DynamoDBClient({})),
  );
  process.env.CURSOR_STATE_TABLE_NAME = TABLE_NAME;
  process.env.USGS_FEED_URL = "https://example.test/feed.geojson";
});

afterEach(() => {
  setDocumentClientForTesting(undefined);
  delete process.env.CURSOR_STATE_TABLE_NAME;
  delete process.env.USGS_FEED_URL;
});

afterAll(() => {
  ddbMock.restore();
});

describe("fetchUsgsFeed", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Never wait on real backoff timers in unit tests.
    setFeedRetrySleepForTesting(async () => undefined);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    setFeedRetrySleepForTesting(undefined);
    warnSpy.mockRestore();
  });

  it("returns the parsed feed JSON on a 2xx response", async () => {
    const feed: UsgsFeatureCollection = { features: [makeFeature()] };
    const feed_ = await fetchUsgsFeed(
      "https://example.test/feed",
      stubFetch(feed),
    );
    expect(feed_).toEqual(feed);
  });

  it("throws when the response is not ok", async () => {
    const failing: FetchLike = () =>
      Promise.resolve({
        ok: false,
        status: 503,
        json: () => Promise.resolve({}),
      });
    await expect(
      fetchUsgsFeed("https://example.test/feed", failing),
    ).rejects.toThrow(/503/);
  });

  it("retries a transient network rejection and succeeds", async () => {
    const feed: UsgsFeatureCollection = { features: [makeFeature()] };
    let calls = 0;
    const flaky: FetchLike = () => {
      calls += 1;
      if (calls === 1) {
        // What the live failure looked like: undici rejecting the request.
        return Promise.reject(new TypeError("fetch failed"));
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(feed),
      });
    };

    const result = await fetchUsgsFeed("https://example.test/feed", flaky);

    expect(result).toEqual(feed);
    expect(calls).toBe(2);
    // The recovered blip still logs a WARN, which the log-error metric filter
    // counts — the retry must not make a transient failure invisible.
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("retries a retryable status then throws after the last attempt", async () => {
    let calls = 0;
    const failing: FetchLike = () => {
      calls += 1;
      return Promise.resolve({
        ok: false,
        status: 503,
        json: () => Promise.resolve({}),
      });
    };

    await expect(
      fetchUsgsFeed("https://example.test/feed", failing),
    ).rejects.toThrow(/503/);

    expect(calls).toBe(FEED_RETRY_DELAYS_MS.length + 1);
  });

  it("does not retry a non-retryable client status", async () => {
    // A 404 means the feed URL is wrong; retrying only delays surfacing it.
    let calls = 0;
    const notFound: FetchLike = () => {
      calls += 1;
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
      });
    };

    await expect(
      fetchUsgsFeed("https://example.test/feed", notFound),
    ).rejects.toThrow(/404/);

    expect(calls).toBe(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("defaults the feed URL to the USGS_FEED_URL env var", async () => {
    const feed: UsgsFeatureCollection = { features: [] };
    let calledWith: string | undefined;
    const recordingFetch: FetchLike = (url) => {
      calledWith = url;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(feed),
      });
    };
    await fetchUsgsFeed(undefined, recordingFetch);
    expect(calledWith).toBe("https://example.test/feed.geojson");
  });
});

describe("featureToEarthquake", () => {
  it("maps a well-formed feature to EarthquakeDetectedData", () => {
    const eq = featureToEarthquake(
      makeFeature({
        id: "us7000n123",
        mag: 5.1,
        place: "Near the coast of Chile",
        time: 1_700_000_000_000,
        tsunami: 1,
        felt: 42,
        alert: "yellow",
        coordinates: [-71.5, -30.2, 12.5],
      }),
    );
    expect(eq).toEqual({
      earthquakeId: "us7000n123",
      magnitude: 5.1,
      place: "Near the coast of Chile",
      coordinates: { longitude: -71.5, latitude: -30.2, depth: 12.5 },
      time: new Date(1_700_000_000_000).toISOString(),
      tsunami: true,
      felt: 42,
      alert: "yellow",
      url: "https://earthquake.usgs.gov/earthquakes/eventpage/us7000abcd",
    });
  });

  it("accepts an ISO 8601 string time", () => {
    const iso = "2023-11-14T22:13:20.000Z";
    const eq = featureToEarthquake(makeFeature({ time: iso }));
    expect(eq?.time).toBe(iso);
  });

  it("normalizes an unrecognized alert to null", () => {
    const eq = featureToEarthquake(makeFeature({ alert: "chartreuse" }));
    expect(eq?.alert).toBeNull();
  });

  it("returns undefined when id is missing", () => {
    expect(featureToEarthquake(makeFeature({ id: undefined }))).toBeUndefined();
  });

  it("returns undefined when magnitude is not finite", () => {
    expect(featureToEarthquake(makeFeature({ mag: null }))).toBeUndefined();
    expect(featureToEarthquake(makeFeature({ mag: "4.2" }))).toBeUndefined();
  });

  it("returns undefined when coordinates are malformed", () => {
    expect(
      featureToEarthquake(makeFeature({ coordinates: [-117.6, 35.6] })),
    ).toBeUndefined();
    expect(
      featureToEarthquake(makeFeature({ coordinates: "nope" })),
    ).toBeUndefined();
  });

  it("returns undefined when time cannot be parsed", () => {
    expect(
      featureToEarthquake(makeFeature({ time: "not-a-date" })),
    ).toBeUndefined();
  });
});

describe("extractEarthquakes", () => {
  it("sorts earthquakes chronologically (oldest first) and skips bad features", () => {
    const feed: UsgsFeatureCollection = {
      features: [
        makeFeature({ id: "c", time: 3000 }),
        makeFeature({ id: "a", time: 1000 }),
        makeFeature({ id: "bad", mag: null }), // skipped
        makeFeature({ id: "b", time: 2000 }),
      ],
    };
    const ids = extractEarthquakes(feed).map((q) => q.earthquakeId);
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("returns an empty array when there are no features", () => {
    expect(extractEarthquakes({})).toEqual([]);
    expect(extractEarthquakes({ features: [] })).toEqual([]);
  });
});

describe("findNewEarthquakes", () => {
  it("returns only earthquakes not already in lastSeenIds, preserving order", () => {
    const feed = extractEarthquakes({
      features: [
        makeFeature({ id: "a", time: 1000 }),
        makeFeature({ id: "b", time: 2000 }),
        makeFeature({ id: "c", time: 3000 }),
      ],
    });
    const fresh = findNewEarthquakes(feed, ["a", "c"]);
    expect(fresh.map((q) => q.earthquakeId)).toEqual(["b"]);
  });

  it("returns all earthquakes when the cursor is empty", () => {
    const feed = extractEarthquakes({
      features: [makeFeature({ id: "a", time: 1000 })],
    });
    expect(findNewEarthquakes(feed, []).map((q) => q.earthquakeId)).toEqual([
      "a",
    ]);
  });
});

describe("mergeLastSeenIds", () => {
  it("appends new ids oldest-first after retained ids", () => {
    expect(mergeLastSeenIds(["a", "b"], ["c", "d"], 10)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("moves a re-seen id to the most-recent end", () => {
    expect(mergeLastSeenIds(["a", "b", "c"], ["b"], 10)).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  it("bounds the window to maxIds, dropping the oldest entries", () => {
    const existing = Array.from({ length: 200 }, (_, i) => `old-${i}`);
    const incoming = ["new-1", "new-2"];
    const merged = mergeLastSeenIds(existing, incoming, USGS_CURSOR_MAX_IDS);
    expect(merged).toHaveLength(USGS_CURSOR_MAX_IDS);
    // Oldest two dropped, newest two appended at the tail.
    expect(merged[0]).toBe("old-2");
    expect(merged.slice(-2)).toEqual(["new-1", "new-2"]);
  });

  it("de-duplicates within the incoming batch", () => {
    expect(mergeLastSeenIds([], ["x", "x", "y"], 10)).toEqual(["x", "y"]);
  });
});

describe("readCursorState", () => {
  it("returns the stored cursor row when present", async () => {
    const stored: UsgsCursorState = {
      cursorId: DEFAULT_CURSOR_ID,
      lastSeenIds: ["a", "b"],
      lastPollAt: "2024-01-01T00:00:00.000Z",
      lastEmittedAt: "2024-01-01T00:00:00.000Z",
      totalEmitted: 2,
    };
    ddbMock.on(GetCommand).resolves({ Item: stored });

    const cursor = await readCursorState();
    expect(cursor).toEqual(stored);

    const call = ddbMock.commandCalls(GetCommand)[0];
    expect(call.args[0].input).toMatchObject({
      TableName: TABLE_NAME,
      Key: { cursorId: DEFAULT_CURSOR_ID },
    });
  });

  it("returns undefined on the first ever poll (no row yet)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    expect(await readCursorState()).toBeUndefined();
  });
});

describe("commitCursor", () => {
  it("writes the updated cursor in a single atomic PutItem", async () => {
    ddbMock.on(PutCommand).resolves({});
    const previous: UsgsCursorState = {
      cursorId: DEFAULT_CURSOR_ID,
      lastSeenIds: ["a", "b"],
      lastPollAt: "2024-01-01T00:00:00.000Z",
      lastEmittedAt: "2024-01-01T00:00:00.000Z",
      totalEmitted: 2,
    };

    const written = await commitCursor({
      previous,
      newlySeenIds: ["c", "d"],
      pollAt: "2024-02-02T00:00:00.000Z",
    });

    expect(written).toEqual({
      cursorId: DEFAULT_CURSOR_ID,
      lastSeenIds: ["a", "b", "c", "d"],
      lastPollAt: "2024-02-02T00:00:00.000Z",
      lastEmittedAt: "2024-02-02T00:00:00.000Z",
      totalEmitted: 4,
    });

    // Exactly one write — atomic cursor advance.
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
    const call = ddbMock.commandCalls(PutCommand)[0];
    expect(call.args[0].input).toMatchObject({
      TableName: TABLE_NAME,
      Item: written,
    });
  });

  it("initializes the cursor on the first poll (no previous row)", async () => {
    ddbMock.on(PutCommand).resolves({});
    const written = await commitCursor({
      newlySeenIds: ["a"],
      pollAt: "2024-02-02T00:00:00.000Z",
    });
    expect(written).toEqual({
      cursorId: DEFAULT_CURSOR_ID,
      lastSeenIds: ["a"],
      lastPollAt: "2024-02-02T00:00:00.000Z",
      lastEmittedAt: "2024-02-02T00:00:00.000Z",
      totalEmitted: 1,
    });
  });

  it("does not advance lastEmittedAt when nothing was emitted", async () => {
    ddbMock.on(PutCommand).resolves({});
    const previous: UsgsCursorState = {
      cursorId: DEFAULT_CURSOR_ID,
      lastSeenIds: ["a"],
      lastPollAt: "2024-01-01T00:00:00.000Z",
      lastEmittedAt: "2024-01-01T00:00:00.000Z",
      totalEmitted: 1,
    };
    const written = await commitCursor({
      previous,
      newlySeenIds: [],
      pollAt: "2024-02-02T00:00:00.000Z",
    });
    expect(written.lastPollAt).toBe("2024-02-02T00:00:00.000Z");
    expect(written.lastEmittedAt).toBe("2024-01-01T00:00:00.000Z");
    expect(written.totalEmitted).toBe(1);
  });

  it("bounds lastSeenIds to USGS_CURSOR_MAX_IDS", async () => {
    ddbMock.on(PutCommand).resolves({});
    const previous: UsgsCursorState = {
      cursorId: DEFAULT_CURSOR_ID,
      lastSeenIds: Array.from({ length: 200 }, (_, i) => `old-${i}`),
      lastPollAt: "2024-01-01T00:00:00.000Z",
      lastEmittedAt: "2024-01-01T00:00:00.000Z",
      totalEmitted: 200,
    };
    const written = await commitCursor({
      previous,
      newlySeenIds: ["fresh"],
    });
    expect(written.lastSeenIds).toHaveLength(USGS_CURSOR_MAX_IDS);
    expect(written.lastSeenIds.at(-1)).toBe("fresh");
    expect(written.lastSeenIds[0]).toBe("old-1");
  });
});

describe("detectNewEarthquakes", () => {
  it("emits only earthquakes new since the cursor across overlapping polls", async () => {
    const feed: UsgsFeatureCollection = {
      features: [
        makeFeature({ id: "a", time: 1000 }),
        makeFeature({ id: "b", time: 2000 }),
        makeFeature({ id: "c", time: 3000 }),
      ],
    };
    ddbMock.on(GetCommand).resolves({
      Item: {
        cursorId: DEFAULT_CURSOR_ID,
        lastSeenIds: ["a"],
        lastPollAt: "2024-01-01T00:00:00.000Z",
        lastEmittedAt: "2024-01-01T00:00:00.000Z",
        totalEmitted: 1,
      } satisfies UsgsCursorState,
    });

    const result = await detectNewEarthquakes({ fetchImpl: stubFetch(feed) });

    expect(result.allEarthquakes.map((q) => q.earthquakeId)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(result.newEarthquakes.map((q) => q.earthquakeId)).toEqual([
      "b",
      "c",
    ]);
    expect(result.cursor?.lastSeenIds).toEqual(["a"]);
  });

  it("treats a first-ever poll (no cursor) as all-new", async () => {
    const feed: UsgsFeatureCollection = {
      features: [makeFeature({ id: "a", time: 1000 })],
    };
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const result = await detectNewEarthquakes({ fetchImpl: stubFetch(feed) });
    expect(result.newEarthquakes.map((q) => q.earthquakeId)).toEqual(["a"]);
    expect(result.cursor).toBeUndefined();
  });
});
