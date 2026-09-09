import { sql } from "@/db/client";
import type { Tx } from "@/db/transaction";
import { validateAssignment, type RuleSettings, type Violation } from "@/rules";
import { loadExistingAssignments, loadShiftSnapshot, loadStaffSnapshot } from "./hydrate";

/**
 * "Sarah is unavailable, but John and Maria could take it."
 *
 * This is the fast path for brief scenario 1 (the Sunday Night Chaos): when an
 * assignment is refused, or when someone calls out an hour before service, the
 * manager needs a ranked list of people who can actually take the shift -- not
 * a directory to filter by hand.
 *
 * Candidates are pre-filtered in SQL to those who are plausibly eligible, then
 * each is run through the full rules engine. Only people with NO blocking
 * violation are offered; anyone carrying warnings is offered with the warnings
 * attached, so the manager sees the cost of each option rather than a list that
 * hides it.
 */

export interface Suggestion {
  staffId: string;
  fullName: string;
  /** Their projected weekly hours if they take this shift. */
  weeklyHoursAfter: number;
  /** Positive when this would push them past their stated desired hours. */
  desiredHoursDelta: number | null;
  /** Non-blocking concerns (overtime, a long day, a 6th consecutive day). */
  warnings: Violation[];
  /** True when taking this shift needs a documented manager override. */
  requiresOverride: boolean;
}

/**
 * Rank by who most needs and can best absorb the hours:
 *   1. people carrying no warnings before those who do
 *   2. then whoever is furthest BELOW their desired hours (fairness)
 *   3. then fewest projected weekly hours (spreads load, limits overtime)
 */
function rankSuggestions(a: Suggestion, b: Suggestion): number {
  if (a.warnings.length !== b.warnings.length) return a.warnings.length - b.warnings.length;

  const deficit = (s: Suggestion) => (s.desiredHoursDelta === null ? 0 : s.desiredHoursDelta);
  if (deficit(a) !== deficit(b)) return deficit(a) - deficit(b);

  return a.weeklyHoursAfter - b.weeklyHoursAfter;
}

export async function suggestAlternatives(
  shiftId: string,
  options: {
    settings: RuleSettings;
    excludeStaffIds?: string[];
    limit?: number;
    tx?: Tx;
    now?: number;
  },
): Promise<Suggestion[]> {
  const db = options.tx ?? sql;
  const shift = await loadShiftSnapshot(db, shiftId);
  if (!shift) return [];

  const excluded = options.excludeStaffIds ?? [];

  // Cheap pre-filter: active, holds the required skill, and holds a
  // certification covering this shift's local date at this location. The
  // expensive per-person rule evaluation only runs on plausible candidates.
  const candidates = await db<{ id: string }[]>`
    select p.id
      from profiles p
      join staff_skills ss on ss.staff_id = p.id and ss.skill_id = ${shift.requiredSkillId}
     where p.is_active
       and is_certified_on(
             p.id,
             ${shift.locationId}::uuid,
             (${new Date(shift.startsAt)}::timestamptz at time zone ${shift.locationTimezone})::date
           )
       and p.id <> all(${excluded.length > 0 ? excluded : [""]}::text[]::uuid[])
       and not exists (
         select 1 from assignments a
          where a.shift_id = ${shiftId} and a.staff_id = p.id and a.status = 'active'
       )
     limit 100
  `;

  const evaluated = await Promise.all(
    candidates.map(async ({ id }): Promise<Suggestion | null> => {
      const staff = await loadStaffSnapshot(db, id);
      if (!staff) return null;

      const existing = await loadExistingAssignments(db, {
        staffId: id,
        aroundStart: shift.startsAt,
        aroundEnd: shift.endsAt,
      });

      const result = validateAssignment({
        staff,
        shift,
        existing,
        settings: options.settings,
        now: options.now,
      });

      // A blocked candidate is not an option; offering one would be noise.
      if (result.blocked) return null;

      return {
        staffId: staff.id,
        fullName: staff.fullName,
        weeklyHoursAfter: result.projection.weeklyHoursAfter,
        desiredHoursDelta: result.projection.desiredHoursDelta,
        warnings: result.warnings,
        requiresOverride: result.requiresOverride,
      };
    }),
  );

  return evaluated
    .filter((s): s is Suggestion => s !== null)
    .sort(rankSuggestions)
    .slice(0, options.limit ?? 5);
}
