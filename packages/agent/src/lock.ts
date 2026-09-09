/**
 * Distributed session lock for the Serverless Agent (task 9.1).
 *
 * Concurrent SQS deliveries for the same customer must not corrupt that
 * customer's session state, so every read-modify-write of a session is
 * serialized behind a per-customer distributed lock (Requirements 6.1, 6.2).
 * Rather than hand-roll the conditional-write / TTL machinery, the agent uses
 * the `@deliveryhero/dynamodb-lock` client backed by the AgentStack session
 * locks DynamoDB table.
 *
 * Library API note: the installed `@deliveryhero/dynamodb-lock` (v2.0.0) does
 * not export a `DynamoDBLock` class. It exposes `dynamoDBLockClientFactory`,
 * which returns a {@link LockClient} whose `lock(lockGroup, lockId, options)`
 * acquires a lock and `releaseLock(lock)` releases it. This module wraps that
 * client behind {@link withLock} so the rest of the agent never touches the
 * library directly.
 *
 * Lock semantics mapped onto the library options (Requirements 6.3, 6.4, 6.5):
 * - **Lease / TTL** -> `leaseDurationInMs: LOCK_TTL_MS` with
 *   `prolongLeaseEnabled: false`. A holder keeps the lock for at most the lease;
 *   if an invocation crashes the lock becomes stealable once the lease elapses,
 *   and the table's `ttl` attribute lets DynamoDB sweep the abandoned row
 *   (Requirement 6.4). We intentionally do NOT prolong the lease: a fixed lease
 *   is the safety net, and prolonging would need a background timer inside the
 *   Lambda.
 *
 *   **Invariant: the lease MUST be at least the holder Lambda's timeout.** With
 *   `prolongLeaseEnabled: false` the lease is fixed at acquisition and a live
 *   holder never refreshes it, so a lease shorter than the maximum possible hold
 *   would let a waiter treat a still-working holder as dead and steal the lock —
 *   two concurrent writers to one session, the exact corruption this lock
 *   exists to prevent. See {@link LOCK_TTL_MS}.
 * - **Contended acquisition** -> `trustLocalTime: true` plus an explicit
 *   {@link LOCK_WAIT_INTERVAL_MS} makes the library poll for the lock. This is
 *   load-bearing: left unset, the library's contended path sleeps for the FULL
 *   `leaseDurationInMs` before re-checking, which is far longer than the
 *   acquisition timeout below — so a waiter got exactly one attempt and was then
 *   guaranteed to time out, no matter how quickly the holder released. See
 *   {@link LOCK_WAIT_INTERVAL_MS}.
 * - **Acquisition timeout** -> acquisition is raced against a
 *   {@link LOCK_ACQUISITION_TIMEOUT_MS} timer. On timeout {@link withLock} throws
 *   {@link LockAcquisitionTimeoutError} so the agent can let the SQS message
 *   return to the queue for retry (Requirement 6.3).
 * - **Owner-only release** -> handled by the library's conditional delete
 *   (only the record-version/owner that holds the lock can release it,
 *   Requirement 6.5).
 *
 * Note that in normal operation this lock should never be contended at all: the
 * event queue is SQS FIFO with one message group per customer, so SQS already
 * delivers a single customer's events one at a time. The lock is the backstop
 * for the cases FIFO does not cover (a redriven message racing a live one, or a
 * future non-queue caller) — which is exactly why its waiting behaviour has to
 * actually work.
 *
 * Table schema: the lock client addresses rows by `customerId` (partition key)
 * plus a constant `lockGroup` sort key, and stores the lease deadline under the
 * `ttl` attribute. See {@link getLockClient} for the configured key names.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocument } from "@aws-sdk/lib-dynamodb";
import {
  dynamoDBLockClientFactory,
  type Lock,
  type LockOptions,
} from "@deliveryhero/dynamodb-lock";

/**
 * Lock lease / TTL in milliseconds (Requirement 6.4).
 *
 * This MUST be >= the agent Lambda's configured timeout (300s in `AgentStack`).
 * Because `prolongLeaseEnabled` is false the lease is fixed at acquisition, so a
 * shorter lease would expire while a legitimate holder is still working — and a
 * waiter, seeing an expired lease, would steal the lock and write the same
 * session concurrently. A holder cannot outlive the Lambda timeout, so pinning
 * the lease to it guarantees an expired lease means a dead holder.
 *
 * The cost of the longer lease is slower recovery from a crashed holder: the
 * lock stays unavailable for up to this long. That is bounded and acceptable —
 * SQS redelivers on a 300s visibility timeout, so a retry arrives about when the
 * lease frees up, and FIFO grouping means only the affected customer waits.
 */
export const LOCK_TTL_MS = 300_000;

/**
 * How long to wait between attempts when the lock is already held.
 *
 * This is the fix for a subtle failure: the library only honours a caller-set
 * wait interval when `trustLocalTime` is true. With both left unset, its
 * contended path sleeps for the whole `leaseDurationInMs` before looking again,
 * so a waiter made a single attempt and then slept far past
 * {@link LOCK_ACQUISITION_TIMEOUT_MS} — every contended acquisition failed even
 * though holders release in a few seconds. Polling at this interval instead lets
 * a waiter pick the lock up as soon as the holder releases.
 */
export const LOCK_WAIT_INTERVAL_MS = 500;

/**
 * Max time to wait to acquire a contended lock (Requirement 6.3).
 *
 * Sized to outlast a typical holder rather than a worst-case one: accumulate
 * invocations hold the lock for roughly 4-9s, so 30s absorbs a predecessor (or
 * two) comfortably. A briefing holder can run far longer (its Bedrock invoke
 * alone is allowed 90s), and in that case timing out is the right outcome — the
 * SQS message returns to the queue and is retried later instead of burning
 * Lambda time blocked on a lock.
 */
export const LOCK_ACQUISITION_TIMEOUT_MS = 30_000;

/**
 * Sort-key value used for every session lock row. The agent only ever locks on
 * `customerId`, so a single constant group keeps all lock rows in one logical
 * group while satisfying the library's composite-key requirement.
 */
export const LOCK_GROUP = "session";

/**
 * Structural subset of the library's `LockClient` that {@link withLock} relies
 * on. Declaring it explicitly lets tests inject a lightweight fake without
 * standing up DynamoDB; the real `LockClient` satisfies this shape.
 */
export interface SessionLockClient {
  lock(
    lockGroup: string,
    lockId: string,
    lockOptions?: LockOptions,
  ): Promise<Lock>;
  releaseLock(lock: Lock): Promise<void>;
}

let lockClient: SessionLockClient | undefined;

/** Resolve the session locks table name from the environment (set by AgentStack). */
function locksTableName(): string {
  const name = process.env.SESSION_LOCKS_TABLE_NAME;
  if (!name) {
    // Misconfiguration — surfaces as a failed invocation so the message retries.
    throw new Error("SESSION_LOCKS_TABLE_NAME is not set");
  }
  return name;
}

/**
 * Return the shared {@link SessionLockClient}, creating it on first use.
 *
 * The client is configured to match the AgentStack session locks table:
 * `customerId` partition key, `lockGroup` sort key, and `ttl` TTL attribute. The
 * library writes the lease deadline into `ttl` so DynamoDB can sweep rows left
 * behind by crashed holders (Requirement 6.4).
 */
export function getLockClient(): SessionLockClient {
  if (!lockClient) {
    const documentClient = DynamoDBDocument.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
    lockClient = dynamoDBLockClientFactory(documentClient, {
      tableName: locksTableName(),
      partitionKey: "customerId",
      sortKey: "lockGroup",
      ttlKey: "ttl",
      ttlInMs: LOCK_TTL_MS,
    });
  }
  return lockClient;
}

/**
 * Override the lock client. Test seam only — production code never calls this.
 * Pass `undefined` to reset back to the lazily-created client.
 */
export function setLockClientForTesting(
  client: SessionLockClient | undefined,
): void {
  lockClient = client;
}

/**
 * Thrown by {@link withLock} when the lock cannot be acquired within
 * {@link LOCK_ACQUISITION_TIMEOUT_MS}. The agent treats this as a transient
 * failure and lets the SQS message return to the queue for retry
 * (Requirement 6.3).
 */
export class LockAcquisitionTimeoutError extends Error {
  constructor(
    public readonly customerId: string,
    public readonly timeoutMs: number,
  ) {
    super(
      `Timed out acquiring session lock for customer ${customerId} after ${timeoutMs}ms`,
    );
    this.name = "LockAcquisitionTimeoutError";
  }
}

/**
 * Acquire the session lock for `customerId`, racing the library's acquisition
 * against a {@link LOCK_ACQUISITION_TIMEOUT_MS} timer. If the timer wins, reject
 * with {@link LockAcquisitionTimeoutError}; if the (slow) acquisition resolves
 * after we've already given up, release that orphaned lock as best-effort
 * cleanup so it doesn't linger for the full lease.
 */
async function acquireWithTimeout(customerId: string): Promise<Lock> {
  const client = getLockClient();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new LockAcquisitionTimeoutError(
          customerId,
          LOCK_ACQUISITION_TIMEOUT_MS,
        ),
      );
    }, LOCK_ACQUISITION_TIMEOUT_MS);
  });

  const acquisition = client.lock(LOCK_GROUP, customerId, {
    leaseDurationInMs: LOCK_TTL_MS,
    prolongLeaseEnabled: false,
    // Poll for a contended lock instead of sleeping a whole lease duration.
    // `waitDurationInMs` is only honoured on the `trustLocalTime` path, so both
    // are required together — see LOCK_WAIT_INTERVAL_MS. `trustLocalTime` is
    // safe here because LOCK_TTL_MS >= the holder Lambda's timeout, so an
    // expired lease always means the holder is gone rather than still working.
    trustLocalTime: true,
    waitDurationInMs: LOCK_WAIT_INTERVAL_MS,
  });

  try {
    return await Promise.race([acquisition, timeout]);
  } catch (error) {
    // If acquisition eventually succeeds after the timeout fired, release the
    // now-orphaned lock instead of holding it until the lease expires.
    void acquisition
      .then((lateLock) => client.releaseLock(lateLock))
      .catch(() => {
        /* best-effort cleanup; nothing else to do */
      });
    throw error;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Run `fn` while holding the per-customer session lock, releasing it in a
 * `finally` so the lock is always freed even if `fn` throws
 * (Requirements 6.1, 6.2, 6.5).
 *
 * @param customerId  The customer whose session is being mutated; used as the
 *                    lock partition key so only one invocation processes a
 *                    given customer at a time.
 * @param fn          The critical section (restore session -> process -> persist).
 * @returns The value returned by `fn`.
 * @throws LockAcquisitionTimeoutError when the lock cannot be acquired within
 *   {@link LOCK_ACQUISITION_TIMEOUT_MS} (Requirement 6.3).
 */
export async function withLock<T>(
  customerId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const client = getLockClient();
  const lock = await acquireWithTimeout(customerId);
  try {
    return await fn();
  } finally {
    await client.releaseLock(lock);
  }
}
