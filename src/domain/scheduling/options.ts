import { sql } from "@/db/client";
import type { Tx } from "@/db/transaction";
import { validateAssignment, type HoursProjection, type Violation } from "@/rules";
import {
  loadExistingAssignmentsForMany,
  loadSettings,
  loadShiftSnapshot,
  loadStaffSnapshots,
} from "./hydrate";

/**
 * Everyone who could plausibly work a shift, each with the full consequence of
 * choosing them.
 *
 * This is deliberately different from suggestAlternatives(), which returns only
 * viable options for the "find coverage fast" path. Here the manager is making
 * a considered choice, so BLOCKED people are returned too, with the reason.
 * Hiding them would leave the manager wondering why someone obvious is missing
 * and re-checking by hand -- showing "Sarah Chen — not available 18:00-20:00"
 * answers the question before it is asked.
 */

export interface AssignmentOption {
  staffId: string;
  fullName: string;
  homeTimezone: string;
  /** Every rule that fires, most severe first. */
  violations: Violation[];
  blocked: boolean;
  requiresOverride: boolean;
  projection: HoursProjection;
  /** Consecutive-day run length if this assignment were made. */
  consecutiveDays: number;
  /** Already on this shift. */
  assigned: boolean;
}

export async function assignmentOptions(
  shiftId: string,
  options: { tx?: Tx; now?: number } = {},
): Promise<AssignmentOption[]> {
  const db = options.tx ?? sql;

  const [settings, shift] = await Promise.all([loadSettings(db), loadShiftSnapshot(db, shiftId)]);
  if (!shift) return [];

  // Candidates are anyone holding the required skill who has EVER been
  // certified at this location. Lapsed certifications are included on purpose:
  // "certification ended 31 Jan" is a more useful answer than silence.
  const candidates = await db<{ id: string; assigned: boolean }[]>`
    select p.id,
           exists (
             select 1 from assignments a
              where a.shift_id = ${shiftId} and a.staff_id = p.id and a.status = 'active'
           ) as assigned
      from profiles p
      join staff_skills ss on ss.staff_id = p.id and ss.skill_id = ${shift.requiredSkillId}
     where p.is_active
       and p.role = 'staff'
       and exists (
         select 1 from staff_certifications c
          where c.staff_id = p.id and c.location_id = ${shift.locationId}
       )
     order by p.full_name
  `;

  // Everything the whole candidate set needs, in a fixed 6 queries rather than
  // 6 per person. Evaluating nine candidates one at a time meant ~55 round
  // trips; over any real app-to-database distance that is seconds of pure
  // network before a single rule runs.
  const staffIds = candidates.map((c) => c.id);
  const [snapshots, assignmentsByStaff] = await Promise.all([
    loadStaffSnapshots(db, staffIds),
    loadExistingAssignmentsForMany(db, {
      staffIds,
      aroundStart: shift.startsAt,
      aroundEnd: shift.endsAt,
    }),
  ]);

  const evaluated = await Promise.all(
    candidates.map(async ({ id, assigned }): Promise<AssignmentOption | null> => {
      const staff = snapshots.get(id);
      if (!staff) return null;

      const existing = assignmentsByStaff.get(id) ?? [];

      // For someone already on the shift, validate as though they were not --
      // otherwise they would show as double-booked against themselves.
      const result = validateAssignment({
        staff,
        shift: assigned ? { ...shift, filledCount: shift.filledCount - 1 } : shift,
        existing: assigned ? existing.filter((a) => a.shiftId !== shiftId) : existing,
        settings,
        now: options.now,
      });

      return {
        staffId: staff.id,
        fullName: staff.fullName,
        homeTimezone: staff.homeTimezone,
        violations: result.violations,
        blocked: result.blocked,
        requiresOverride: result.requiresOverride,
        projection: result.projection,
        consecutiveDays: result.consecutive.length,
        assigned,
      };
    }),
  );

  // Assigned first (so the manager sees the current roster), then viable
  // options, then people carrying warnings, then blocked with their reasons.
  const rank = (o: AssignmentOption) =>
    o.assigned ? 0 : o.blocked ? 3 : o.requiresOverride ? 2 : o.violations.length > 0 ? 1 : 0.5;

  return evaluated
    .filter((o): o is AssignmentOption => o !== null)
    .sort((a, b) => rank(a) - rank(b) || a.fullName.localeCompare(b.fullName));
}
