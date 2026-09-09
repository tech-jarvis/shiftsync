import { checkHeadcount, checkEditCutoff } from "./capacity";
import { checkConflicts } from "./conflicts";
import { consecutiveRun, checkConsecutiveDays, type ConsecutiveRun } from "./consecutive";
import { checkAvailabilityWindow, checkCertification, checkSkill } from "./eligibility";
import { checkDailyHours, checkWeeklyHours, projectHours, type HoursProjection } from "./hours";
import {
  DEFAULT_SETTINGS,
  type RuleCode,
  type Severity,
  type ValidationInput,
  type Violation,
} from "./types";

/**
 * The constraint engine's public entry point.
 *
 * Pure and synchronous: hand it a hydrated snapshot, get back every rule that
 * fires. It never touches a database, which is what makes the entire rule
 * surface -- including the timezone and DST edges -- testable in milliseconds.
 *
 * The engine runs in three places, and it is the same code each time:
 *   1. before a write, so the manager gets an explanation instead of an error
 *   2. after a database exclusion-constraint rejection (SQLSTATE 23P01), to
 *      turn an opaque conflict into a sentence naming the conflicting shift
 *   3. in the what-if preview, so the numbers shown before confirming are
 *      literally the numbers the rules will use
 */

export interface ValidationResult {
  /** Every rule that fired, most severe first. */
  violations: Violation[];
  /** True when the assignment cannot be saved at all. */
  blocked: boolean;
  /** True when it can only be saved alongside a documented override. */
  requiresOverride: boolean;
  overrideCodes: RuleCode[];
  /** Advisory only -- safe to save, but show them before confirming. */
  warnings: Violation[];
  /** Hour totals before and after, for the what-if preview and OT dashboard. */
  projection: HoursProjection;
  consecutive: ConsecutiveRun;
}

const SEVERITY_ORDER: Record<Severity, number> = {
  block: 0,
  override_required: 1,
  warn: 2,
};

/**
 * Every check, in the order a human would ask them: can this person do this job
 * at all, is the time physically possible, is there room, and finally -- is it a
 * good idea?
 */
const CHECKS = [
  // Hard eligibility: no reading under which these are merely unwise.
  checkSkill,
  checkCertification,
  checkAvailabilityWindow,
  // Physical impossibility, mirrored by the database exclusion constraint.
  checkConflicts,
  // Properties of the shift rather than the person.
  checkHeadcount,
  checkEditCutoff,
  // Advisory, and the reason the what-if preview exists.
  checkDailyHours,
  checkWeeklyHours,
  checkConsecutiveDays,
] as const;

export function validateAssignment(input: ValidationInput): ValidationResult {
  const normalized: ValidationInput = {
    ...input,
    settings: input.settings ?? DEFAULT_SETTINGS,
    now: input.now ?? Date.now(),
  };

  const violations = CHECKS.flatMap((check) => check(normalized)).sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );

  const overrides = violations.filter((v) => v.severity === "override_required");

  return {
    violations,
    blocked: violations.some((v) => v.severity === "block"),
    requiresOverride: overrides.length > 0,
    overrideCodes: overrides.map((v) => v.code),
    warnings: violations.filter((v) => v.severity === "warn"),
    projection: projectHours(normalized),
    consecutive: consecutiveRun(normalized),
  };
}

/**
 * Validate several proposed assignments together.
 *
 * A swap is two changes (each party takes the other's shift), a handoff is one,
 * publishing a week is many. Validating them as a set -- with the released
 * assignments already removed from each staff member's existing list -- is what
 * stops a straight swap from reporting itself as a double-booking.
 *
 * Callers build each input with the outgoing assignment already excluded from
 * `existing`; this helper simply runs them and reports per-change results, so
 * the caller can reject the whole set atomically if any single change blocks.
 */
export interface ChangeSetResult {
  results: ValidationResult[];
  blocked: boolean;
  requiresOverride: boolean;
}

export function validateChangeSet(inputs: ValidationInput[]): ChangeSetResult {
  const results = inputs.map(validateAssignment);

  return {
    results,
    blocked: results.some((r) => r.blocked),
    requiresOverride: results.some((r) => r.requiresOverride),
  };
}

export * from "./availability";
export * from "./capacity";
export * from "./conflicts";
export * from "./consecutive";
export * from "./eligibility";
export * from "./format";
export * from "./hours";
export * from "./interval";
export * from "./types";
