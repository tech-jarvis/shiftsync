import type { TransactionSql } from "postgres";
import { sql } from "./client";

/**
 * Transaction helpers for the assignment write path.
 *
 * Two guarantees are layered here, and they cover different ground:
 *
 *   THE DATABASE CONSTRAINT (see the assignments migration) makes overlapping
 *   assignments and sub-10-hour turnarounds structurally impossible. No lock is
 *   needed for those -- the race window does not exist.
 *
 *   THE ADVISORY LOCK below covers the rules a single-row constraint cannot
 *   express: weekly hours, daily caps, consecutive days, and the pending-request
 *   cap. Those read many rows to decide, so without serialization two
 *   concurrent writes could each read 32 hours, each add 8, and both commit --
 *   leaving the person at 48 with neither transaction ever having seen a
 *   violation. Locking per staff member closes that, and is far cheaper than
 *   SERIALIZABLE with its retry loops.
 */

export type Tx = TransactionSql<Record<string, never>>;

/**
 * Run `fn` in a transaction, tagged with the acting user so the audit triggers
 * can attribute every row they write.
 *
 * `set_config(..., true)` is transaction-local, so the setting unwinds with the
 * transaction and cannot leak onto the next request sharing the pooled
 * connection.
 */
export async function withActor<T>(
  actorId: string | null,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    if (actorId) {
      await tx`select set_config('app.actor_id', ${actorId}, true)`;
    }
    return fn(tx as Tx);
  }) as Promise<T>;
}

/**
 * Serialize this transaction against any other touching the same staff members.
 *
 * Locks are taken in sorted id order. That detail is load-bearing: a mutual swap
 * locks two people at once, and if two such transactions took their locks in
 * opposite orders they would deadlock. A canonical order makes that impossible.
 *
 * The lock is transaction-scoped, so it releases on commit or rollback with no
 * unlock call to forget.
 *
 * Namespace 1 is staff; namespace 2 is shifts (taken by the headcount trigger).
 * Staff locks are always acquired before shift locks, which is what keeps the
 * two lock families free of deadlock cycles.
 */
export async function lockStaff(tx: Tx, staffIds: string[]): Promise<void> {
  const ordered = [...new Set(staffIds)].sort();

  for (const staffId of ordered) {
    await tx`select pg_advisory_xact_lock(1, hashtext(${staffId}::text))`;
  }
}

/**
 * The standard shape of an assignment-mutating transaction: actor tagged for
 * audit, and every affected staff member locked before any rule is evaluated.
 */
export async function withStaffLock<T>(
  actorId: string | null,
  staffIds: string[],
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return withActor(actorId, async (tx) => {
    await lockStaff(tx, staffIds);
    return fn(tx);
  });
}
