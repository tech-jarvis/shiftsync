import postgres from "postgres";
import { requireEnv } from "@/lib/env";

/**
 * Server-side Postgres client.
 *
 * Used for everything that needs transactional control the Supabase JS client
 * cannot express: advisory locks, multi-statement transactions, and reading
 * SQLSTATE codes off constraint violations. Read paths that only need
 * RLS-filtered selects go through the Supabase client instead, so policies do
 * the authorization work.
 */

const connectionString = requireEnv("DATABASE_URL");

export const sql = postgres(connectionString, {
  // Postgres enum and range types arrive as strings; we parse them explicitly at
  // the boundary rather than letting a driver guess.
  transform: { undefined: null },
  max: 10,
  idle_timeout: 20,
});

export type Sql = typeof sql;

/** SQLSTATE codes this application interprets rather than merely reporting. */
export const PG_ERRORS = {
  /** exclusion_violation -- the no-overlap / minimum-rest constraint fired. */
  EXCLUSION_VIOLATION: "23P01",
  /** unique_violation -- e.g. the same person twice on one shift. */
  UNIQUE_VIOLATION: "23505",
  /** check_violation -- raised by our headcount and pending-request-cap triggers. */
  CHECK_VIOLATION: "23514",
  /** raise_exception -- generic RAISE from a trigger without an explicit errcode. */
  RAISE_EXCEPTION: "P0001",
  /**
   * deadlock_detected -- the OTHER way a concurrent double-booking is refused.
   *
   * Two inserts arriving close enough together can each end up waiting on the
   * other's speculative row in the GiST index; Postgres breaks the tie by
   * aborting one as a deadlock instead of reporting the exclusion violation.
   * Characterised over 30 races against a real database: 23 returned 23P01 and
   * 7 returned 40P01, and in every single case exactly one transaction
   * committed. Both codes mean the same thing to a user -- the database refused
   * a conflicting concurrent write -- so both must be handled identically.
   */
  DEADLOCK_DETECTED: "40P01",
} as const;

export function isPgError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

/** The constraint name Postgres reports, when it reports one. */
export function pgConstraintName(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "constraint_name" in error) {
    const name = (error as { constraint_name?: unknown }).constraint_name;
    return typeof name === "string" ? name : null;
  }
  return null;
}
