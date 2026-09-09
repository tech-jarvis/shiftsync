import { formatInstant, formatRange, hoursLabel } from "./format";
import { MS_PER_HOUR, overlaps } from "./interval";
import {
  assignmentInterval,
  DEFAULT_SETTINGS,
  shiftInterval,
  type ValidationInput,
  type Violation,
} from "./types";

/**
 * Double-booking and minimum-rest checks.
 *
 * These two rules are ALSO enforced structurally by the database, via a single
 * GiST exclusion constraint on assignments (see the migration for the padded
 * range trick and its boundary proof). That is deliberate duplication with
 * distinct jobs:
 *
 *   the constraint  -- guarantees the invariant; no race can defeat it
 *   this module     -- explains it, before the write for good UX and after a
 *                      23P01 rejection to turn an opaque SQLSTATE into a
 *                      sentence naming the conflicting shift
 *
 * The boundary semantics are kept identical on purpose: exactly `minRestHours`
 * of rest is ALLOWED in both, because tstzrange is half-open and the comparison
 * here is a strict `<`. If these two ever disagree, users see a violation
 * explained that the database then permits (or worse, the reverse).
 */
export function checkConflicts(input: ValidationInput): Violation[] {
  const { staff, shift, existing, settings = DEFAULT_SETTINGS } = input;
  const candidate = shiftInterval(shift);
  const minRestMs = settings.minRestHours * MS_PER_HOUR;
  const violations: Violation[] = [];

  for (const other of existing) {
    // The shift being validated is not a conflict with itself. This matters
    // when re-validating an existing assignment after a shift edit.
    if (other.shiftId === shift.id) continue;

    const existingSpan = assignmentInterval(other);

    if (overlaps(candidate, existingSpan)) {
      violations.push({
        code: "DOUBLE_BOOKED",
        severity: "block",
        message:
          `${staff.fullName} is already working ${other.locationName} on ` +
          `${formatRange(other.startsAt, other.endsAt, other.locationTimezone)}, ` +
          `which overlaps this shift.`,
        meta: {
          conflictingAssignmentId: other.id,
          conflictingShiftId: other.shiftId,
          locationName: other.locationName,
        },
      });
      continue;
    }

    // No overlap, so one strictly precedes the other; measure the gap between.
    const gapMs =
      candidate.start >= existingSpan.end
        ? candidate.start - existingSpan.end
        : existingSpan.start - candidate.end;

    if (gapMs < minRestMs) {
      const isAfter = candidate.start >= existingSpan.end;
      const boundaryMs = isAfter ? existingSpan.end : existingSpan.start;

      violations.push({
        code: "INSUFFICIENT_REST",
        severity: "block",
        message:
          `${staff.fullName} would get only ${hoursLabel(gapMs / MS_PER_HOUR)} of rest ` +
          `${isAfter ? "after" : "before"} their ${other.locationName} shift ` +
          `${isAfter ? "ending" : "starting"} ${formatInstant(boundaryMs, other.locationTimezone)}. ` +
          `The minimum is ${hoursLabel(settings.minRestHours)} between shifts.`,
        meta: {
          conflictingAssignmentId: other.id,
          conflictingShiftId: other.shiftId,
          gapHours: gapMs / MS_PER_HOUR,
          requiredHours: settings.minRestHours,
        },
      });
    }
  }

  return violations;
}
