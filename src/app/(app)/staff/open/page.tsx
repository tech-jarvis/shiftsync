import { sql } from "@/db/client";
import { loadExistingAssignments, loadSettings, loadShiftSnapshot, loadStaffSnapshot } from "@/domain/scheduling/hydrate";
import { requireUser } from "@/lib/auth";
import { validateAssignment } from "@/rules";
import { OpenShifts, type OpenShiftView } from "@/components/staff/OpenShifts";

/**
 * Shifts this person could pick up: unfilled published shifts, and shifts
 * colleagues have offered up.
 *
 * Every candidate is run through the full rules engine before it is shown, and
 * anything that would be blocked is filtered out. Listing a shift someone
 * cannot legally take -- only to refuse them after they tap it -- would be a
 * worse experience than not listing it, and this list is read in a hurry.
 */

export default async function OpenShiftsPage() {
  const user = await requireUser();
  const settings = await loadSettings();

  // Unfilled published shifts at locations this person is certified for,
  // requiring a skill they hold.
  const unfilled = await sql<{ shiftId: string; requestId: null }[]>`
    select s.id as "shiftId", null::uuid as "requestId"
      from shifts s
      join staff_skills ss on ss.skill_id = s.required_skill_id and ss.staff_id = ${user.profileId}
     where s.is_published
       and s.starts_at > now()
       and is_certified_on(${user.profileId}, s.location_id,
             (s.starts_at at time zone (select timezone from locations where id = s.location_id))::date)
       and (select count(*) from assignments a
             where a.shift_id = s.id and a.status = 'active') < s.headcount
       and not exists (
         select 1 from assignments a
          where a.shift_id = s.id and a.staff_id = ${user.profileId} and a.status = 'active'
       )
     order by s.starts_at
     limit 40
  `;

  // Shifts colleagues have offered up and nobody has claimed.
  const dropped = await sql<{ shiftId: string; requestId: string }[]>`
    select a.shift_id as "shiftId", sr.id as "requestId"
      from swap_requests sr
      join assignments a on a.id = sr.requester_assignment_id
      join shifts s      on s.id = a.shift_id
      join staff_skills ss on ss.skill_id = s.required_skill_id and ss.staff_id = ${user.profileId}
     where sr.kind = 'drop'
       and sr.state = 'open'
       and sr.expires_at > now()
       and sr.requester_id <> ${user.profileId}
       and is_certified_on(${user.profileId}, s.location_id,
             (s.starts_at at time zone (select timezone from locations where id = s.location_id))::date)
     order by a.starts_at
     limit 40
  `;

  const staff = await loadStaffSnapshot(sql, user.profileId);

  const evaluate = async (
    shiftId: string,
    requestId: string | null,
  ): Promise<OpenShiftView | null> => {
    const shift = await loadShiftSnapshot(sql, shiftId);
    if (!shift || !staff) return null;

    const existing = await loadExistingAssignments(sql, {
      staffId: user.profileId,
      aroundStart: shift.startsAt,
      aroundEnd: shift.endsAt,
    });

    const result = validateAssignment({ staff, shift, existing, settings });
    if (result.blocked) return null;

    return {
      shiftId,
      requestId,
      startsAt: new Date(shift.startsAt).toISOString(),
      endsAt: new Date(shift.endsAt).toISOString(),
      locationName: shift.locationName,
      locationTimezone: shift.locationTimezone,
      skillName: shift.requiredSkillName,
      isPremium: false,
      warnings: result.warnings,
      weeklyHoursAfter: result.projection.weeklyHoursAfter,
    };
  };

  const candidates = await Promise.all([
    ...unfilled.map((row) => evaluate(row.shiftId, null)),
    ...dropped.map((row) => evaluate(row.shiftId, row.requestId)),
  ]);

  const available = candidates
    .filter((s): s is OpenShiftView => s !== null)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">Open shifts</h1>
        <p className="text-sm text-[var(--text-muted)] mt-0.5">
          Only shifts you can actually take are listed — each one has been checked against your
          skills, certifications, availability and rest requirements.
        </p>
      </header>

      <OpenShifts shifts={available} profileId={user.profileId} />
    </div>
  );
}
