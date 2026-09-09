/**
 * Unit tests for the Subscription Manager scheduled refresh logic (task 10.2).
 *
 * The refresh orchestration's I/O — enumerating active customers, calling MCP
 * `events/subscribe`, and reading/writing subscription records via the Data API
 * — is replaced with in-memory fakes via {@link setRefreshDependenciesForTesting},
 * so these tests exercise the REAL refresh logic (expiry detection, missing
 * detection, secret rotation, per-customer failure isolation, and record
 * persistence) without SigV4 signing or network/AWS access.
 *
 * Covered (Requirements 8.2, 8.4, 8.5, 15.3):
 * - the pure expiry / missing-detection helpers,
 * - refreshing subscriptions expiring within the threshold (and leaving
 *   not-yet-expiring ones alone),
 * - optionally rotating the per-subscription `whsec_` secret on refresh,
 * - persisting new `expiresAt` / `lastRefreshedAt` on the record,
 * - re-creating a missing subscription for an active customer,
 * - logging and isolating a per-customer failure so the run continues.
 */

import type { CustomerConfig, SubscribeResult } from "@mcp-events/shared";
import {
  EVENT_NAME_BRIEFING_TRIGGER,
  EVENT_NAME_EARTHQUAKE_DETECTED,
  WHSEC_SECRET_PREFIX,
} from "@mcp-events/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ActiveCustomer,
  type RefreshDependencies,
  type SubscribeOnServerInputs,
  type SubscriptionRecord,
  buildInputSchema,
  findExpiringSubscriptions,
  findMissingServers,
  isExpiringWithin,
  refreshExpiringSubscriptions,
  serverForEventName,
  setRefreshDependenciesForTesting,
  SCHEDULER_SERVER,
  USGS_SERVER,
} from "./refresh.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2024-01-01T00:00:00.000Z");
const NOW_MS = NOW.getTime();

const CUSTOMER_ID = "33333333-3333-4333-8333-333333333333";
const USGS_SUB_ID = "11111111-1111-4111-8111-111111111111";
const SCHED_SUB_ID = "22222222-2222-4222-8222-222222222222";

const WEBHOOK_URL = "https://webhook.earthquake-agent.example.com/webhook";

/** Structurally valid `whsec_` secret (prefix + base64 of 32 bytes). */
const EXISTING_SECRET = `${WHSEC_SECRET_PREFIX}${Buffer.alloc(32, 7).toString("base64")}`;

function makeConfig(overrides: Partial<CustomerConfig> = {}): CustomerConfig {
  return {
    customerId: CUSTOMER_ID,
    displayName: "Test Customer",
    subscriptionParams: { minMagnitude: 4.5, region: "pacific" },
    briefingPrompt: "Summarize seismic activity.",
    briefingSchedule: 24,
    active: true,
    createdAt: "2023-12-01T00:00:00.000Z",
    updatedAt: "2023-12-01T00:00:00.000Z",
    ...overrides,
  };
}

/** ISO string `seconds` after NOW. */
function isoAfter(seconds: number): string {
  return new Date(NOW_MS + seconds * 1000).toISOString();
}

function makeUsgsSub(
  overrides: Partial<SubscriptionRecord> = {},
): SubscriptionRecord {
  return {
    subscriptionId: USGS_SUB_ID,
    customerId: CUSTOMER_ID,
    serverEndpoint: WEBHOOK_URL,
    eventName: EVENT_NAME_EARTHQUAKE_DETECTED,
    callbackUrl: WEBHOOK_URL,
    secret: EXISTING_SECRET,
    filterParams: { minMagnitude: 4.5, region: "pacific" },
    createdAt: "2023-12-01T00:00:00.000Z",
    expiresAt: isoAfter(300), // 5 min out — within the default 10 min threshold
    lastRefreshedAt: "2023-12-01T00:00:00.000Z",
    status: "active",
    ...overrides,
  };
}

function makeSchedulerSub(
  overrides: Partial<SubscriptionRecord> = {},
): SubscriptionRecord {
  return {
    subscriptionId: SCHED_SUB_ID,
    customerId: CUSTOMER_ID,
    serverEndpoint: WEBHOOK_URL,
    eventName: EVENT_NAME_BRIEFING_TRIGGER,
    callbackUrl: WEBHOOK_URL,
    secret: EXISTING_SECRET,
    schedule: 24,
    createdAt: "2023-12-01T00:00:00.000Z",
    expiresAt: isoAfter(300),
    lastRefreshedAt: "2023-12-01T00:00:00.000Z",
    status: "active",
    ...overrides,
  };
}

/**
 * Build an in-memory {@link RefreshDependencies} fake. The subscribe call mints
 * a deterministic id per (customer, server) unless told to mint a new id, and
 * records every subscribe call and persisted record for assertions.
 */
function makeFakeDeps(
  customers: ActiveCustomer[],
  options: {
    /** Return a brand-new subscriptionId from subscribe (server re-mint case). */
    mintNewId?: string;
    /** Make subscribe throw for a given customerId (failure isolation test). */
    failForCustomerId?: string;
    /** Have the PUT fail with 404 so the upsert falls back to POST. */
  } = {},
): {
  deps: RefreshDependencies;
  subscribeCalls: SubscribeOnServerInputs[];
  upserts: SubscriptionRecord[];
} {
  const subscribeCalls: SubscribeOnServerInputs[] = [];
  const upserts: SubscriptionRecord[] = [];

  const deps: RefreshDependencies = {
    listActiveCustomers: () => Promise.resolve(customers),
    subscribeOnServer: (inputs) => {
      subscribeCalls.push(inputs);
      if (
        options.failForCustomerId &&
        inputs.customerId === options.failForCustomerId
      ) {
        return Promise.reject(new Error("simulated subscribe failure"));
      }
      const result: SubscribeResult = {
        subscriptionId:
          options.mintNewId ??
          (inputs.server === USGS_SERVER ? USGS_SUB_ID : SCHED_SUB_ID),
        expiresAt: isoAfter(inputs.ttlSeconds),
      };
      return Promise.resolve(result);
    },
    upsertSubscriptionRecord: (record) => {
      upserts.push(record);
      return Promise.resolve();
    },
    resolveCallbackUrl: () => WEBHOOK_URL,
  };

  return { deps, subscribeCalls, upserts };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("expiry detection", () => {
  it("flags a subscription expiring within the threshold", () => {
    expect(isExpiringWithin({ expiresAt: isoAfter(300) }, NOW_MS, 600)).toBe(
      true,
    );
  });

  it("leaves a subscription comfortably outside the threshold", () => {
    expect(isExpiringWithin({ expiresAt: isoAfter(3600) }, NOW_MS, 600)).toBe(
      false,
    );
  });

  it("treats an already-expired subscription as expiring", () => {
    expect(isExpiringWithin({ expiresAt: isoAfter(-60) }, NOW_MS, 600)).toBe(
      true,
    );
  });

  it("treats a malformed expiresAt as expiring (heals the record)", () => {
    expect(isExpiringWithin({ expiresAt: "not-a-date" }, NOW_MS, 600)).toBe(
      true,
    );
  });

  it("selects only the expiring subscriptions from a set", () => {
    const expiring = makeUsgsSub({ expiresAt: isoAfter(120) });
    const fresh = makeSchedulerSub({ expiresAt: isoAfter(7200) });
    const result = findExpiringSubscriptions([expiring, fresh], NOW_MS, 600);
    expect(result).toEqual([expiring]);
  });
});

describe("missing-subscription detection", () => {
  it("reports no missing servers when both are present", () => {
    expect(findMissingServers([makeUsgsSub(), makeSchedulerSub()])).toEqual([]);
  });

  it("reports the scheduler server missing when only USGS is present", () => {
    expect(findMissingServers([makeUsgsSub()])).toEqual([SCHEDULER_SERVER]);
  });

  it("reports both servers missing when there are no subscriptions", () => {
    expect(findMissingServers([])).toEqual([USGS_SERVER, SCHEDULER_SERVER]);
  });
});

describe("buildInputSchema", () => {
  it("maps the interval for the scheduler server", () => {
    expect(buildInputSchema(SCHEDULER_SERVER, makeConfig())).toEqual({
      intervalHours: 24,
    });
  });

  it("maps only the defined filter dimensions for the USGS server", () => {
    const config = makeConfig({
      subscriptionParams: { minMagnitude: 5 },
    });
    expect(buildInputSchema(USGS_SERVER, config)).toEqual({ minMagnitude: 5 });
  });

  it("maps an empty filter when no params are set", () => {
    const config = makeConfig({ subscriptionParams: {} });
    expect(buildInputSchema(USGS_SERVER, config)).toEqual({});
  });
});

describe("serverForEventName", () => {
  it("maps event names to their server descriptors", () => {
    expect(serverForEventName(EVENT_NAME_EARTHQUAKE_DETECTED)).toBe(
      USGS_SERVER,
    );
    expect(serverForEventName(EVENT_NAME_BRIEFING_TRIGGER)).toBe(
      SCHEDULER_SERVER,
    );
  });
});

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

describe("refreshExpiringSubscriptions", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    setRefreshDependenciesForTesting(undefined);
    vi.restoreAllMocks();
  });

  it("refreshes subscriptions expiring within the threshold", async () => {
    const customer: ActiveCustomer = {
      config: makeConfig(),
      subscriptions: [makeUsgsSub(), makeSchedulerSub()],
    };
    const { deps, subscribeCalls, upserts } = makeFakeDeps([customer]);

    const summary = await refreshExpiringSubscriptions({ now: NOW }, deps);

    expect(summary.refreshed).toBe(2);
    expect(summary.recreated).toBe(0);
    expect(summary.failed).toBe(0);
    expect(subscribeCalls).toHaveLength(2);
    // Each record is persisted with a new expiry and lastRefreshedAt == now.
    expect(upserts).toHaveLength(2);
    for (const record of upserts) {
      expect(record.lastRefreshedAt).toBe(NOW.toISOString());
      expect(Date.parse(record.expiresAt)).toBeGreaterThan(NOW_MS);
      expect(record.status).toBe("active");
    }
  });

  it("does not refresh subscriptions that are not yet expiring", async () => {
    const customer: ActiveCustomer = {
      config: makeConfig(),
      subscriptions: [
        makeUsgsSub({ expiresAt: isoAfter(7200) }),
        makeSchedulerSub({ expiresAt: isoAfter(7200) }),
      ],
    };
    const { deps, subscribeCalls } = makeFakeDeps([customer]);

    const summary = await refreshExpiringSubscriptions({ now: NOW }, deps);

    expect(summary.refreshed).toBe(0);
    expect(summary.recreated).toBe(0);
    expect(subscribeCalls).toHaveLength(0);
  });

  it("re-supplies the existing secret when not rotating", async () => {
    const customer: ActiveCustomer = {
      config: makeConfig(),
      subscriptions: [makeUsgsSub()],
    };
    const { deps, subscribeCalls, upserts } = makeFakeDeps([customer]);

    await refreshExpiringSubscriptions({ now: NOW, rotateSecret: false }, deps);

    expect(subscribeCalls[0].secret).toBe(EXISTING_SECRET);
    expect(upserts[0].secret).toBe(EXISTING_SECRET);
  });

  it("re-derives the schedule from config, discarding a legacy value", async () => {
    // Regression: a record written before the cron -> interval migration still
    // carries a STRING `schedule`. Carrying it forward verbatim made the Data
    // API reject the write with a 400 on every refresh, and because the upsert
    // only falls back to creating on a 404, the subscription could never be
    // re-registered — so the Webhook Receiver 401'd every delivery.
    const legacy = makeSchedulerSub({
      schedule: "0 */8 * * *" as unknown as number,
    });
    const customer: ActiveCustomer = {
      config: makeConfig({ briefingSchedule: 4 }),
      subscriptions: [legacy],
    };
    const { deps, upserts } = makeFakeDeps([customer]);

    const summary = await refreshExpiringSubscriptions({ now: NOW }, deps);

    expect(summary.refreshed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(upserts[0].schedule).toBe(4);
    // The USGS-only field is cleared so a record never carries both.
    expect(upserts[0].filterParams).toBeUndefined();
  });

  it("re-derives filterParams from config on a USGS refresh", async () => {
    const customer: ActiveCustomer = {
      config: makeConfig({ subscriptionParams: { minMagnitude: 6 } }),
      // A stray `schedule` on a USGS record must not survive the refresh.
      subscriptions: [makeUsgsSub({ schedule: 24 })],
    };
    const { deps, upserts } = makeFakeDeps([customer]);

    await refreshExpiringSubscriptions({ now: NOW }, deps);

    expect(upserts[0].filterParams).toEqual({ minMagnitude: 6 });
    expect(upserts[0].schedule).toBeUndefined();
  });

  it("rotates the per-subscription secret when requested", async () => {
    const customer: ActiveCustomer = {
      config: makeConfig(),
      subscriptions: [makeUsgsSub()],
    };
    const { deps, subscribeCalls, upserts } = makeFakeDeps([customer]);

    const summary = await refreshExpiringSubscriptions(
      { now: NOW, rotateSecret: true },
      deps,
    );

    // A fresh whsec_ secret is generated and supplied both to the server and
    // persisted via the Data API.
    expect(subscribeCalls[0].secret).not.toBe(EXISTING_SECRET);
    expect(subscribeCalls[0].secret.startsWith(WHSEC_SECRET_PREFIX)).toBe(true);
    expect(upserts[0].secret).toBe(subscribeCalls[0].secret);
    expect(summary.outcomes[0].rotated).toBe(true);
  });

  it("re-creates a missing subscription for an active customer", async () => {
    // Only the USGS subscription exists; the scheduler one is missing.
    const customer: ActiveCustomer = {
      config: makeConfig(),
      subscriptions: [makeUsgsSub({ expiresAt: isoAfter(7200) })],
    };
    const { deps, subscribeCalls, upserts } = makeFakeDeps([customer], {
      mintNewId: SCHED_SUB_ID,
    });

    const summary = await refreshExpiringSubscriptions({ now: NOW }, deps);

    expect(summary.recreated).toBe(1);
    expect(subscribeCalls).toHaveLength(1);
    expect(subscribeCalls[0].server).toBe(SCHEDULER_SERVER);
    // The re-created record carries the scheduler schedule + a fresh secret.
    const created = upserts.find(
      (r) => r.eventName === EVENT_NAME_BRIEFING_TRIGGER,
    );
    expect(created).toBeDefined();
    expect(created?.schedule).toBe(24);
    expect(created?.secret.startsWith(WHSEC_SECRET_PREFIX)).toBe(true);
  });

  it("isolates a per-customer failure and continues the run", async () => {
    // The failing customer has both subscriptions (so no missing re-creation);
    // both refresh attempts fail because subscribe throws for this customer.
    const failing: ActiveCustomer = {
      config: makeConfig({ customerId: CUSTOMER_ID }),
      subscriptions: [makeUsgsSub(), makeSchedulerSub()],
    };
    const otherId = "44444444-4444-4444-8444-444444444444";
    const healthy: ActiveCustomer = {
      config: makeConfig({ customerId: otherId }),
      subscriptions: [
        makeUsgsSub({
          subscriptionId: "55555555-5555-4555-8555-555555555555",
          customerId: otherId,
        }),
        makeSchedulerSub({
          subscriptionId: "66666666-6666-4666-8666-666666666666",
          customerId: otherId,
        }),
      ],
    };
    const { deps, upserts } = makeFakeDeps([failing, healthy], {
      failForCustomerId: CUSTOMER_ID,
    });

    const summary = await refreshExpiringSubscriptions({ now: NOW }, deps);

    expect(summary.customersProcessed).toBe(2);
    expect(summary.failed).toBe(2);
    expect(summary.refreshed).toBe(2);
    // Only the healthy customer's records were persisted despite the other's failures.
    expect(upserts).toHaveLength(2);
    expect(upserts.every((r) => r.customerId === otherId)).toBe(true);
    // The failures were logged with the customer id (Requirement 8.4 / 18.3).
    expect(console.error).toHaveBeenCalled();
  });

  it("processes no customers gracefully", async () => {
    const { deps } = makeFakeDeps([]);
    const summary = await refreshExpiringSubscriptions({ now: NOW }, deps);
    expect(summary).toEqual({
      customersProcessed: 0,
      refreshed: 0,
      recreated: 0,
      failed: 0,
      outcomes: [],
    });
  });
});
