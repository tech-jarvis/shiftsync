"use server";

import { DateTime } from "luxon";
import { revalidatePath } from "next/cache";
import { sql } from "@/db/client";
import { assignStaffToShift, releaseAssignment, type AssignOutcome } from "@/domain/scheduling/assign";
import { assignmentOptions, type AssignmentOption } from "@/domain/scheduling/options";
import { requireRole } from "@/lib/auth";

/**
 * Server actions for the manager schedule.
 *
 * Every action re-checks the caller's role AND their location scope. The RLS
 * policies would also stop an out-of-scope write, but these actions use the
 * privileged `sql` connection for transactional control, so scope has to be
 * asserted explicitly here -- this is the one place the RLS safety net does not
 * apply, and it is checked accordingly.
 */

async function assertManagesShift(shiftId: string): Promise<{ profileId: string }> {
  const user = await requireRole("manager", "admin");

  const [row] = await sql<{ locationId: string }[]>`
    select location_id as "locationId" from shifts where id = ${shiftId}
  `;
  if (!row) throw new Error("Shift not found.");

  if (user.role !== "admin" && !user.locationIds.includes(row.locationId)) {
    throw new Error("You do not manage this location.");
  }
  return { profileId: user.profileId };
}

export async function loadAssignmentOptions(shiftId: string): Promise<AssignmentOption[]> {
  await assertManagesShift(shiftId);
  return assignmentOptions(shiftId);
}

export async function assignAction(
  shiftId: string,
  staffId: string,
  overrideReason?: string,
): Promise<AssignOutcome> {
  const { profileId } = await assertManagesShift(shiftId);

  const outcome = await assignStaffToShift({
    actorId: profileId,
    shiftId,
    staffId,
    override: overrideReason ? { reason: overrideReason } : undefined,
  });

  if (outcome.status === "assigned") revalidatePath("/schedule");
  return outcome;
}

export async function releaseAction(assignmentId: string): Promise<{ released: boolean }> {
  const user = await requireRole("manager", "admin");

  const [row] = await sql<{ locationId: string }[]>`
    select s.location_id as "locationId"
      from assignments a join shifts s on s.id = a.shift_id
     where a.id = ${assignmentId}
  `;
  if (!row) throw new Error("Assignment not found.");
  if (user.role !== "admin" && !user.locationIds.includes(row.locationId)) {
    throw new Error("You do not manage this location.");
  }

  const result = await releaseAssignment({ actorId: user.profileId, assignmentId });
  revalidatePath("/schedule");
  return result;
}

/**
 * Publish or unpublish a week at one location.
 *
 * Publishing makes the week visible to staff -- enforced by the RLS policy on
 * shifts, not by a query filter, so an unpublished draft cannot leak through
 * any endpoint or realtime channel.
 *
 * Shifts already inside the edit cutoff are left alone rather than silently
 * flipped, and the count of skipped shifts is reported back.
 */
export async function setWeekPublished(
  locationId: string,
  weekStartISO: string,
  published: boolean,
): Promise<{ changed: number; skipped: number }> {
  const user = await requireRole("manager", "admin");
  if (user.role !== "admin" && !user.locationIds.includes(locationId)) {
    throw new Error("You do not manage this location.");
  }

  const weekStart = new Date(weekStartISO);
  const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000);

  const [{ cutoffHours }] = await sql<{ cutoffHours: string }[]>`
    select value::text as "cutoffHours" from app_settings where key = 'edit_cutoff_hours'
  `;
  const cutoffMs = Number(cutoffHours) * 3_600_000;

  const changed = await sql<{ id: string }[]>`
    update shifts
       set is_published = ${published},
           published_at = ${published ? new Date() : null},
           version      = version + 1
     where location_id = ${locationId}
       and starts_at  >= ${weekStart}
       and starts_at   < ${weekEnd}
       and is_published <> ${published}
       and starts_at > ${new Date(Date.now() + cutoffMs)}
    returning id
  `;

  const skipped = await sql<{ id: string }[]>`
    select id from shifts
     where location_id = ${locationId}
       and starts_at  >= ${weekStart}
       and starts_at   < ${weekEnd}
       and is_published <> ${published}
       and starts_at <= ${new Date(Date.now() + cutoffMs)}
  `;

  // Tell everyone whose shifts just became visible.
  if (published && changed.length > 0) {
    await sql`
      insert into notifications (recipient_id, kind, title, body, entity_type, entity_id)
      select distinct a.staff_id, 'schedule_published',
             'Your schedule has been published',
             'The schedule for the week of ' || to_char(${weekStart}::date, 'DD Mon') ||
               ' is now available.',
             'shifts', a.shift_id
        from assignments a
       where a.shift_id = any(${changed.map((c) => c.id)}::uuid[])
         and a.status = 'active'
    `;
  }

  revalidatePath("/schedule");
  return { changed: changed.length, skipped: skipped.length };
}

/**
 * Create a shift.
 *
 * Times arrive as local wall-clock strings plus the location's zone, and are
 * converted to instants here. That is the only correct direction: a manager
 * types "18:00" meaning six in the evening at that restaurant, and what gets
 * stored is the instant that corresponds to.
 *
 * An end time earlier than the start is read as running past midnight rather
 * than rejected -- an 23:00-03:00 shift is an ordinary thing to schedule, and
 * making the manager tick a box to say so is friction for no gain.
 */
export async function createShiftAction(input: {
  locationId: string;
  skillId: string;
  /** Local date, 'YYYY-MM-DD', in the location's timezone. */
  date: string;
  /** Local wall-clock 'HH:mm' in the location's timezone. */
  startTime: string;
  endTime: string;
  headcount: number;
  notes?: string;
}): Promise<{ ok: boolean; shiftId?: string; error?: string }> {
  const user = await requireRole("manager", "admin");

  if (user.role !== "admin" && !user.locationIds.includes(input.locationId)) {
    return { ok: false, error: "You do not manage this location." };
  }
  if (input.headcount < 1) {
    return { ok: false, error: "Headcount must be at least 1." };
  }

  const [location] = await sql<{ timezone: string }[]>`
    select timezone from locations where id = ${input.locationId}
  `;
  if (!location) return { ok: false, error: "Location not found." };

  const start = DateTime.fromISO(`${input.date}T${input.startTime}`, { zone: location.timezone });
  let end = DateTime.fromISO(`${input.date}T${input.endTime}`, { zone: location.timezone });

  if (!start.isValid || !end.isValid) {
    return { ok: false, error: "That date or time could not be read." };
  }
  // An end at or before the start means the shift runs into the next day.
  if (end <= start) end = end.plus({ days: 1 });

  if (end.diff(start, "hours").hours > 24) {
    return { ok: false, error: "A shift cannot be longer than 24 hours." };
  }

  try {
    const [shift] = await sql<{ id: string }[]>`
      insert into shifts (location_id, required_skill_id, starts_at, ends_at, headcount, notes, created_by)
      values (${input.locationId}, ${input.skillId}, ${start.toJSDate()}, ${end.toJSDate()},
              ${input.headcount}, ${input.notes ?? null}, ${user.profileId})
      returning id
    `;
    revalidatePath("/schedule");
    return { ok: true, shiftId: shift.id };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not create that shift.",
    };
  }
}

/** Delete a draft shift. Published shifts are unpublished first, never deleted. */
export async function deleteShiftAction(shiftId: string): Promise<{ ok: boolean; error?: string }> {
  await assertManagesShift(shiftId);

  const [shift] = await sql<{ isPublished: boolean }[]>`
    select is_published as "isPublished" from shifts where id = ${shiftId}
  `;
  if (shift?.isPublished) {
    return {
      ok: false,
      error: "Unpublish this shift before deleting it, so anyone scheduled on it is notified.",
    };
  }

  await sql`delete from shifts where id = ${shiftId}`;
  revalidatePath("/schedule");
  return { ok: true };
}

/** The change history of one shift -- the brief's "history of any shift". */
export async function shiftHistory(shiftId: string): Promise<
  { occurredAt: string; actorName: string; entityType: string; action: string; changed: string[] }[]
> {
  await assertManagesShift(shiftId);

  const rows = await sql<
    {
      occurredAt: Date;
      actorName: string;
      entityType: string;
      action: string;
      beforeState: Record<string, unknown> | null;
      afterState: Record<string, unknown> | null;
    }[]
  >`
    select al.occurred_at              as "occurredAt",
           coalesce(p.full_name, 'system') as "actorName",
           al.entity_type              as "entityType",
           al.action,
           al.before_state             as "beforeState",
           al.after_state              as "afterState"
      from audit_log al
      left join profiles p on p.id = al.actor_id
     where (al.entity_type = 'shifts' and al.entity_id = ${shiftId}::uuid)
        or (al.entity_type in ('assignments', 'swap_requests', 'rule_overrides')
            and coalesce(al.after_state, al.before_state) ->> 'shift_id' = ${shiftId})
     order by al.occurred_at desc
     limit 50
  `;

  const NOISE = new Set(["updated_at", "version"]);

  return rows.map((row) => ({
    occurredAt: row.occurredAt.toISOString(),
    actorName: row.actorName,
    entityType: row.entityType,
    action: row.action,
    changed:
      row.beforeState && row.afterState
        ? Object.keys(row.afterState).filter(
            (key) =>
              !NOISE.has(key) &&
              JSON.stringify(row.afterState![key]) !== JSON.stringify(row.beforeState![key]),
          )
        : [],
  }));
}
