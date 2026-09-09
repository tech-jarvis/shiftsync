"use server";

import { revalidatePath } from "next/cache";
import { sql } from "@/db/client";
import {
  claimDrop,
  requestDrop,
  requestSwap,
  respondToSwap,
  withdrawRequest,
  type SwapOutcome,
} from "@/domain/swaps/service";
import { assignStaffToShift, type AssignOutcome } from "@/domain/scheduling/assign";
import { requireUser } from "@/lib/auth";

/**
 * Staff-facing actions.
 *
 * Each one passes the CALLER'S profile id to the service rather than accepting
 * one from the client: the service's own guards then verify ownership, so a
 * forged staff id in a request body cannot act on someone else's shift.
 */

export async function offerShiftUp(assignmentId: string): Promise<SwapOutcome> {
  const user = await requireUser();
  const outcome = await requestDrop({ requesterId: user.profileId, assignmentId });
  revalidatePath("/staff");
  return outcome;
}

export async function askColleagueToCover(
  assignmentId: string,
  targetStaffId: string,
): Promise<SwapOutcome> {
  const user = await requireUser();
  const outcome = await requestSwap({
    requesterId: user.profileId,
    assignmentId,
    targetStaffId,
  });
  revalidatePath("/staff");
  return outcome;
}

export async function answerSwap(requestId: string, accept: boolean): Promise<SwapOutcome> {
  const user = await requireUser();
  const outcome = await respondToSwap({
    targetStaffId: user.profileId,
    requestId,
    accept,
  });
  revalidatePath("/staff");
  return outcome;
}

export async function pickUpShift(requestId: string): Promise<SwapOutcome> {
  const user = await requireUser();
  const outcome = await claimDrop({ claimantId: user.profileId, requestId });
  revalidatePath("/staff");
  revalidatePath("/staff/open");
  return outcome;
}

export async function cancelMyRequest(requestId: string): Promise<SwapOutcome> {
  const user = await requireUser();
  const outcome = await withdrawRequest({ requesterId: user.profileId, requestId });
  revalidatePath("/staff");
  return outcome;
}

/** Colleagues who could be asked to cover a specific shift. */
export async function coverCandidates(
  assignmentId: string,
): Promise<{ id: string; fullName: string }[]> {
  const user = await requireUser();

  return sql<{ id: string; fullName: string }[]>`
    select p.id, p.full_name as "fullName"
      from assignments a
      join shifts s        on s.id = a.shift_id
      join staff_skills ss on ss.skill_id = s.required_skill_id
      join profiles p      on p.id = ss.staff_id
     where a.id = ${assignmentId}
       and a.staff_id = ${user.profileId}
       and p.is_active
       and p.id <> ${user.profileId}
       and is_certified_on(p.id, s.location_id,
             (s.starts_at at time zone (select timezone from locations where id = s.location_id))::date)
     order by p.full_name
  `;
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export async function addAvailabilityRule(
  isoWeekday: number,
  startMinute: number,
  endMinute: number,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();

  if (endMinute <= startMinute) {
    return { ok: false, error: "The end time must be after the start time." };
  }
  if (endMinute > startMinute + 1440) {
    return { ok: false, error: "A single window cannot be longer than 24 hours." };
  }

  await sql`
    insert into availability_rules (staff_id, iso_weekday, start_minute, end_minute, timezone)
    values (${user.profileId}, ${isoWeekday}, ${startMinute}, ${endMinute}, ${user.homeTimezone})
  `;
  revalidatePath("/staff/availability");
  return { ok: true };
}

export async function removeAvailabilityRule(ruleId: string): Promise<void> {
  const user = await requireUser();
  await sql`
    delete from availability_rules where id = ${ruleId} and staff_id = ${user.profileId}
  `;
  revalidatePath("/staff/availability");
}

export async function addAvailabilityException(
  date: string,
  isAvailable: boolean,
  startMinute: number | null,
  endMinute: number | null,
  reason: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();

  if (isAvailable && startMinute === null) {
    return { ok: false, error: "Extra availability needs a time window." };
  }

  await sql`
    insert into availability_exceptions
      (staff_id, on_date, is_available, start_minute, end_minute, timezone, reason)
    values (${user.profileId}, ${date}::date, ${isAvailable},
            ${startMinute}, ${endMinute}, ${user.homeTimezone}, ${reason})
    on conflict (staff_id, on_date, start_minute) do update
      set is_available = excluded.is_available,
          end_minute   = excluded.end_minute,
          reason       = excluded.reason
  `;
  revalidatePath("/staff/availability");
  return { ok: true };
}

export async function removeAvailabilityException(exceptionId: string): Promise<void> {
  const user = await requireUser();
  await sql`
    delete from availability_exceptions where id = ${exceptionId} and staff_id = ${user.profileId}
  `;
  revalidatePath("/staff/availability");
}

/**
 * Claim an UNFILLED published shift directly.
 *
 * DECISION (documented in DECISIONS.md): picking up an unfilled shift does not
 * need manager approval, while taking over someone's dropped shift does. The
 * asymmetry is deliberate -- a drop releases a person from an obligation, which
 * a manager should see; an unfilled shift has no counterparty and is currently
 * unstaffed, so coverage is strictly an improvement and making a manager
 * approve it just slows down the exact situation the brief cares most about.
 *
 * The full rules engine still runs, so nobody can pick up a shift that would
 * double-book them, breach their rest, or fall outside their availability.
 */
export async function pickUpOpenShift(shiftId: string): Promise<AssignOutcome> {
  const user = await requireUser();
  return assignStaffToShift({
    actorId: user.profileId,
    shiftId,
    staffId: user.profileId,
  });
}
