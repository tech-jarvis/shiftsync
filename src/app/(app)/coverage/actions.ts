"use server";

import { revalidatePath } from "next/cache";
import { sql } from "@/db/client";
import { decideRequest, type SwapOutcome } from "@/domain/swaps/service";
import { requireRole } from "@/lib/auth";

export async function decide(
  requestId: string,
  approve: boolean,
  note?: string,
): Promise<SwapOutcome> {
  const user = await requireRole("manager", "admin");

  const [row] = await sql<{ locationId: string }[]>`
    select s.location_id as "locationId"
      from swap_requests sr
      join assignments a on a.id = sr.requester_assignment_id
      join shifts s      on s.id = a.shift_id
     where sr.id = ${requestId}
  `;
  if (!row) throw new Error("Request not found.");
  if (user.role !== "admin" && !user.locationIds.includes(row.locationId)) {
    throw new Error("You do not manage this location.");
  }

  const outcome = await decideRequest({
    managerId: user.profileId,
    requestId,
    approve,
    note,
  });

  revalidatePath("/coverage");
  revalidatePath("/schedule");
  return outcome;
}
