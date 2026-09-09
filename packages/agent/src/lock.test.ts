/**
 * Unit tests for the distributed session lock helper (task 9.1).
 *
 * These tests verify that {@link withLock} correctly wraps the
 * `@deliveryhero/dynamodb-lock` client: it acquires before running the critical
 * section, releases afterwards (including on error), maps the 60s lease and 10s
 * acquisition timeout onto the library, and surfaces a typed timeout error so
 * the agent can retry via SQS (Requirements 6.1, 6.2, 6.3, 6.5).
 *
 * The library client is replaced with a lightweight fake via
 * {@link setLockClientForTesting}; the real DynamoDB-backed serialization
 * behavior is covered separately by the integration test in task 9.2.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LOCK_ACQUISITION_TIMEOUT_MS,
  LOCK_GROUP,
  LOCK_TTL_MS,
  LOCK_WAIT_INTERVAL_MS,
  LockAcquisitionTimeoutError,
  type SessionLockClient,
  setLockClientForTesting,
  withLock,
} from "./lock.js";

/** A minimal stand-in for the library's `Lock` object. */
function fakeLock(lockId: string): unknown {
  return { lockId, lockGroup: LOCK_GROUP, isAcquired: true };
}

interface LockCall {
  lockGroup: string;
  lockId: string;
  options?: {
    leaseDurationInMs?: number;
    prolongLeaseEnabled?: boolean;
    trustLocalTime?: boolean;
    waitDurationInMs?: number;
  };
}

/**
 * Build a fake lock client that records calls and lets each test control the
 * acquire/release outcomes.
 */
function makeFakeClient(opts?: {
  acquire?: (lockId: string) => Promise<unknown>;
  release?: (lock: unknown) => Promise<void>;
}): {
  client: SessionLockClient;
  lockCalls: LockCall[];
  releaseCalls: unknown[];
} {
  const lockCalls: LockCall[] = [];
  const releaseCalls: unknown[] = [];

  const client: SessionLockClient = {
    lock: vi.fn(
      async (
        lockGroup: string,
        lockId: string,
        options?: LockCall["options"],
      ) => {
        lockCalls.push({ lockGroup, lockId, options });
        const acquire =
          opts?.acquire ?? ((id: string) => Promise.resolve(fakeLock(id)));
        return acquire(lockId);
      },
    ) as unknown as SessionLockClient["lock"],
    releaseLock: vi.fn(async (lock: unknown) => {
      releaseCalls.push(lock);
      if (opts?.release) {
        await opts.release(lock);
      }
    }) as unknown as SessionLockClient["releaseLock"],
  };

  return { client, lockCalls, releaseCalls };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  setLockClientForTesting(undefined);
});

describe("withLock", () => {
  it("acquires the lock keyed on customerId, runs fn, then releases", async () => {
    const { client, lockCalls, releaseCalls } = makeFakeClient();
    setLockClientForTesting(client);

    const order: string[] = [];
    const result = await withLock("cust-1", async () => {
      order.push("fn");
      return "value";
    });

    expect(result).toBe("value");
    // fn ran exactly once, between acquire and release.
    expect(order).toEqual(["fn"]);
    expect(lockCalls).toHaveLength(1);
    expect(lockCalls[0].lockGroup).toBe(LOCK_GROUP);
    expect(lockCalls[0].lockId).toBe("cust-1");
    expect(releaseCalls).toHaveLength(1);
  });

  it("configures the lease, disables prolonging, and polls while contended", async () => {
    const { client, lockCalls } = makeFakeClient();
    setLockClientForTesting(client);

    await withLock("cust-2", async () => undefined);

    expect(lockCalls[0].options).toMatchObject({
      leaseDurationInMs: LOCK_TTL_MS,
      prolongLeaseEnabled: false,
      // Both are required together: the library only honours waitDurationInMs on
      // the trustLocalTime path, and without them a contended waiter sleeps a
      // whole lease duration and can never acquire within the timeout.
      trustLocalTime: true,
      waitDurationInMs: LOCK_WAIT_INTERVAL_MS,
    });
  });

  it("keeps the lease at least as long as the agent Lambda timeout", () => {
    // Invariant: with prolongLeaseEnabled false the lease is fixed at
    // acquisition, so it must outlast the longest possible hold. A holder cannot
    // outlive the Lambda timeout (300s in AgentStack), so a lease below that
    // would let a waiter steal the lock from a still-working holder and corrupt
    // the session. Keep this in sync if the Lambda timeout changes.
    const AGENT_LAMBDA_TIMEOUT_MS = 300_000;
    expect(LOCK_TTL_MS).toBeGreaterThanOrEqual(AGENT_LAMBDA_TIMEOUT_MS);
    // The poll interval must also be well under the acquisition budget,
    // otherwise a waiter still gets only one attempt.
    expect(LOCK_WAIT_INTERVAL_MS).toBeLessThan(
      LOCK_ACQUISITION_TIMEOUT_MS / 2,
    );
  });

  it("releases the lock even when fn throws, and propagates the error", async () => {
    const { client, releaseCalls } = makeFakeClient();
    setLockClientForTesting(client);

    const boom = new Error("processing failed");
    await expect(
      withLock("cust-3", async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    // finally-block release ran despite the thrown error.
    expect(releaseCalls).toHaveLength(1);
  });

  it("returns the value produced by fn", async () => {
    const { client } = makeFakeClient();
    setLockClientForTesting(client);

    const value = await withLock("cust-4", async () => ({ count: 42 }));
    expect(value).toEqual({ count: 42 });
  });

  it("throws LockAcquisitionTimeoutError when acquisition exceeds the timeout", async () => {
    // Acquisition never resolves within the timeout window.
    const { client, releaseCalls } = makeFakeClient({
      acquire: () => new Promise<unknown>(() => undefined),
    });
    setLockClientForTesting(client);

    const fn = vi.fn(async () => "should-not-run");
    const promise = withLock("cust-5", fn);
    // Surface the rejection synchronously so the test runner sees it handled
    // before we advance timers (avoids an unhandled-rejection warning).
    const assertion = expect(promise).rejects.toBeInstanceOf(
      LockAcquisitionTimeoutError,
    );

    await vi.advanceTimersByTimeAsync(LOCK_ACQUISITION_TIMEOUT_MS);
    await assertion;

    // Critical section never ran and there was no acquired lock to release.
    expect(fn).not.toHaveBeenCalled();
    expect(releaseCalls).toHaveLength(0);
  });

  it("carries the customerId and timeout on the timeout error", async () => {
    const { client } = makeFakeClient({
      acquire: () => new Promise<unknown>(() => undefined),
    });
    setLockClientForTesting(client);

    const promise = withLock("cust-6", async () => undefined);
    const assertion = expect(promise).rejects.toMatchObject({
      customerId: "cust-6",
      timeoutMs: LOCK_ACQUISITION_TIMEOUT_MS,
    });

    await vi.advanceTimersByTimeAsync(LOCK_ACQUISITION_TIMEOUT_MS);
    await assertion;
  });

  it("releases a lock that is acquired late (after the timeout fired)", async () => {
    let resolveAcquire: (() => void) | undefined;
    const { client, releaseCalls } = makeFakeClient({
      acquire: (id) =>
        new Promise((resolve) => {
          resolveAcquire = () => resolve(fakeLock(id));
        }),
    });
    setLockClientForTesting(client);

    const promise = withLock("cust-7", async () => "unused");
    const assertion = expect(promise).rejects.toBeInstanceOf(
      LockAcquisitionTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(LOCK_ACQUISITION_TIMEOUT_MS);
    await assertion;

    // The slow acquisition finally resolves; the orphaned lock is released.
    resolveAcquire?.();
    await vi.runAllTimersAsync();
    expect(releaseCalls).toHaveLength(1);
  });
});
