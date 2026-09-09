"use server";

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
