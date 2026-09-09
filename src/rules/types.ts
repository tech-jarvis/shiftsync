import type { AvailabilityException, AvailabilityRule } from "./availability";
import type { Interval } from "./interval";

/**
 * The vocabulary the whole system speaks about scheduling legality.
 *
 * A `Violation` is not an error string -- it carries the rule that fired, how
 * hard it bites, a sentence a manager can act on, and structured `meta` the UI
 * uses to link to the offending shift. The brief requires the system to
 * "clearly explain which rule was broken and why"; that requirement is
 * discharged by this type being rich enough to render without guesswork.
 */

export type RuleCode =
  | "DOUBLE_BOOKED"
  | "INSUFFICIENT_REST"
  | "MISSING_SKILL"
  | "NOT_CERTIFIED"
  | "OUTSIDE_AVAILABILITY"
  | "DAILY_HOURS_WARN"
  | "DAILY_HOURS_BLOCK"
  | "WEEKLY_HOURS_WARN"
  | "WEEKLY_OVERTIME"
  | "CONSECUTIVE_DAYS_WARN"
  | "CONSECUTIVE_DAYS_OVERRIDE"
  | "SHIFT_FULL"
  | "SHIFT_LOCKED";

/**
 * block             -- refuse the assignment outright
 * override_required -- refuse unless a manager records a documented reason
 * warn              -- allow, but surface prominently before confirming
 */
export type Severity = "block" | "warn" | "override_required";

export interface Violation {
  code: RuleCode;
  severity: Severity;
  /** A complete sentence naming the rule and the specific conflict. */
  message: string;
  meta?: Record<string, unknown>;
}

export const isBlocking = (v: Violation) => v.severity === "block";
export const needsOverride = (v: Violation) => v.severity === "override_required";

/** Anything that prevents saving without manager intervention. */
export function blocksAssignment(violations: Violation[]): boolean {
  return violations.some((v) => isBlocking(v) || needsOverride(v));
}

// ---------------------------------------------------------------------------
// Tunable thresholds
// ---------------------------------------------------------------------------
// Mirrors the app_settings table so the engine stays pure (no database reads)
// while still being driven by the same numbers the rest of the system uses.

export interface RuleSettings {
  minRestHours: number;
  dailyHoursWarn: number;
  dailyHoursBlock: number;
  weeklyHoursWarn: number;
  weeklyHoursOvertime: number;
  consecutiveDaysWarn: number;
  consecutiveDaysOverride: number;
  editCutoffHours: number;
  maxPendingRequests: number;
  dropExpiryHours: number;
  premiumStartHour: number;
  /**
   * ISO weekday the labour week starts on. The brief says "weekly hours
   * approaching 40" without defining the week boundary; we use Monday and say
   * so in DECISIONS.md.
   */
  weekStartsOn: number;
}

export const DEFAULT_SETTINGS: RuleSettings = {
  minRestHours: 10,
  dailyHoursWarn: 8,
  dailyHoursBlock: 12,
  weeklyHoursWarn: 35,
  weeklyHoursOvertime: 40,
  consecutiveDaysWarn: 6,
  consecutiveDaysOverride: 7,
  editCutoffHours: 48,
  maxPendingRequests: 3,
  dropExpiryHours: 24,
  premiumStartHour: 17,
  weekStartsOn: 1,
};

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------
// Every snapshot is plain data. The engine never reaches for a database, which
// is what lets the entire rule surface be unit-tested at millisecond speed.

export interface CertificationWindow {
  locationId: string;
  /** Local date 'YYYY-MM-DD'. */
  effectiveFrom: string;
  /** Local date 'YYYY-MM-DD', or null for open-ended. */
  effectiveTo: string | null;
}

export interface StaffSnapshot {
  id: string;
  fullName: string;
  /** Anchor zone for availability AND for person-centric hour aggregation. */
  homeTimezone: string;
  skillIds: string[];
  certifications: CertificationWindow[];
  availabilityRules: AvailabilityRule[];
  availabilityExceptions: AvailabilityException[];
  desiredWeeklyHours: number | null;
}

export interface ShiftSnapshot {
  id: string;
  locationId: string;
  locationName: string;
  /** Zone the shift's hours are displayed in, and the zone premium-ness is judged in. */
  locationTimezone: string;
  requiredSkillId: string;
  requiredSkillName: string;
  /** Epoch ms. */
  startsAt: number;
  endsAt: number;
  headcount: number;
  /** Active assignments already on this shift, excluding the candidate. */
  filledCount: number;
  isPublished: boolean;
}

/** One of the staff member's other active assignments. */
export interface ExistingAssignment {
  id: string;
  shiftId: string;
  startsAt: number;
  endsAt: number;
  locationName: string;
  locationTimezone: string;
}

export interface ValidationInput {
  staff: StaffSnapshot;
  shift: ShiftSnapshot;
  /**
   * The staff member's other active assignments. When validating a swap, the
   * assignment being given up is omitted -- which is exactly why a swap that
   * would otherwise look like a double-booking validates cleanly.
   */
  existing: ExistingAssignment[];
  settings?: RuleSettings;
  /** Injected for determinism in tests. Defaults to Date.now(). */
  now?: number;
}

export const shiftInterval = (shift: ShiftSnapshot): Interval => ({
  start: shift.startsAt,
  end: shift.endsAt,
});

export const assignmentInterval = (a: ExistingAssignment): Interval => ({
  start: a.startsAt,
  end: a.endsAt,
});
