import { checkAvailability } from "./availability";
import { formatRange, hoursLabel, localDateKey } from "./format";
import { durationHours } from "./interval";
import { shiftInterval, type ValidationInput, type Violation } from "./types";

/**
 * Can this person work this shift at all -- skill, certification, availability?
 *
 * These three are hard blocks. Unlike hours-based rules, there is no reading
 * under which assigning an uncertified or unskilled person is merely unwise.
 */

/** Does the staff member hold the skill the shift requires? */
export function checkSkill(input: ValidationInput): Violation[] {
  const { staff, shift } = input;

  if (staff.skillIds.includes(shift.requiredSkillId)) return [];

  return [
    {
      code: "MISSING_SKILL",
      severity: "block",
      message:
        `This shift requires the ${shift.requiredSkillName} skill, which ` +
        `${staff.fullName} does not have.`,
      meta: { requiredSkillId: shift.requiredSkillId, requiredSkillName: shift.requiredSkillName },
    },
  ];
}

/**
 * Was the staff member certified at this location on the day of the shift?
 *
 * Judged against the shift's LOCAL date in the LOCATION's timezone: certification
 * is permission to work at a place, so that place's calendar is the right one.
 * Judged as-of the shift date rather than today, which is what keeps historical
 * shifts explicable after a de-certification (see DECISIONS.md).
 */
export function checkCertification(input: ValidationInput): Violation[] {
  const { staff, shift } = input;
  const shiftDate = localDateKey(shift.startsAt, shift.locationTimezone);

  const covering = staff.certifications.find(
    (c) =>
      c.locationId === shift.locationId &&
      c.effectiveFrom <= shiftDate &&
      (c.effectiveTo === null || shiftDate <= c.effectiveTo),
  );

  if (covering) return [];

  // Distinguish "never certified here" from "certification has lapsed", because
  // the manager's next action differs: re-certify, or pick someone else.
  const lapsed = staff.certifications
    .filter((c) => c.locationId === shift.locationId && c.effectiveTo !== null)
    .sort((a, b) => (a.effectiveTo! < b.effectiveTo! ? 1 : -1))[0];

  return [
    {
      code: "NOT_CERTIFIED",
      severity: "block",
      message: lapsed
        ? `${staff.fullName}'s certification for ${shift.locationName} ended on ` +
          `${lapsed.effectiveTo}, before this shift on ${shiftDate}.`
        : `${staff.fullName} is not certified to work at ${shift.locationName}.`,
      meta: {
        locationId: shift.locationId,
        locationName: shift.locationName,
        shiftDate,
        lapsedOn: lapsed?.effectiveTo ?? null,
      },
    },
  ];
}

/**
 * Is the shift inside the staff member's stated availability?
 *
 * The gap is reported in the LOCATION's timezone (the manager is looking at a
 * location's schedule) while naming the zone the availability was declared in,
 * so a cross-timezone mismatch reads as a mismatch rather than as a bug.
 */
export function checkAvailabilityWindow(input: ValidationInput): Violation[] {
  const { staff, shift } = input;
  const span = shiftInterval(shift);

  const verdict = checkAvailability(
    staff.availabilityRules,
    staff.availabilityExceptions,
    span,
  );

  if (verdict.isAvailable) return [];

  const uncoveredHours = verdict.gaps.reduce((sum, gap) => sum + durationHours(gap), 0);
  const gapDescriptions = verdict.gaps.map((gap) =>
    formatRange(gap.start, gap.end, shift.locationTimezone),
  );

  const crossesTimezones = staff.homeTimezone !== shift.locationTimezone;

  return [
    {
      code: "OUTSIDE_AVAILABILITY",
      severity: "block",
      message:
        `${staff.fullName} is not available for ${hoursLabel(uncoveredHours)} of this shift ` +
        `(${gapDescriptions.join("; ")}).` +
        (crossesTimezones
          ? ` Their availability is set in ${staff.homeTimezone}, while this shift is in ` +
            `${shift.locationTimezone}.`
          : ""),
      meta: {
        gaps: verdict.gaps,
        uncoveredHours,
        staffTimezone: staff.homeTimezone,
        locationTimezone: shift.locationTimezone,
        crossesTimezones,
      },
    },
  ];
}
