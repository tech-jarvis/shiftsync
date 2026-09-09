import { formatInstant, hoursLabel } from "./format";
import { MS_PER_HOUR } from "./interval";
import { DEFAULT_SETTINGS, type ValidationInput, type Violation } from "./types";

/**
 * Rules about the shift itself rather than about the person: is there a seat
 * left, and is the schedule still open for editing?
 */

/** Is there an unfilled slot on this shift? */
export function checkHeadcount(input: ValidationInput): Violation[] {
  const { shift } = input;

  if (shift.filledCount < shift.headcount) return [];

  return [
    {
      code: "SHIFT_FULL",
      severity: "block",
      message:
        `This shift already has all ${shift.headcount} ` +
        `${shift.headcount === 1 ? "position" : "positions"} filled.`,
      meta: { headcount: shift.headcount, filledCount: shift.filledCount },
    },
  ];
}

/**
 * The edit cutoff: a PUBLISHED shift locks a configurable number of hours
 * before it starts (default 48).
 *
 * Only published shifts lock. An unpublished draft is not yet a promise to
 * anyone, so there is nothing to protect staff from changing.
 *
 * This is a `block` rather than `override_required` because the brief presents
 * the cutoff as the boundary of the manager's editing authority. Genuine
 * emergencies inside the cutoff are handled through the swap/drop and coverage
 * flow, which is designed for exactly that and keeps everyone notified --
 * rather than by silently rewriting a schedule people have already planned
 * their week around.
 */
export function checkEditCutoff(input: ValidationInput): Violation[] {
  const { shift, settings = DEFAULT_SETTINGS, now = Date.now() } = input;

  if (!shift.isPublished) return [];

  const cutoffAt = shift.startsAt - settings.editCutoffHours * MS_PER_HOUR;
  if (now < cutoffAt) return [];

  const hoursUntilStart = (shift.startsAt - now) / MS_PER_HOUR;

  return [
    {
      code: "SHIFT_LOCKED",
      severity: "block",
      message:
        hoursUntilStart >= 0
          ? `This published shift starts in ${hoursLabel(hoursUntilStart)} and is inside the ` +
            `${hoursLabel(settings.editCutoffHours)} edit cutoff. Use a swap or coverage ` +
            `request instead so everyone affected is notified.`
          : `This shift started ${formatInstant(shift.startsAt, shift.locationTimezone)} and ` +
            `can no longer be edited.`,
      meta: {
        cutoffAt,
        cutoffHours: settings.editCutoffHours,
        hoursUntilStart,
      },
    },
  ];
}
