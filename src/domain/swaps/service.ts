import { isPgError, PG_ERRORS, sql } from "@/db/client";
import { withStaffLock, type Tx } from "@/db/transaction";
import { managersOfLocation, notify } from "@/domain/notifications";
import {
  loadExistingAssignments,
  loadSettings,
  loadShiftSnapshot,
  loadStaffSnapshot,
} from "@/domain/scheduling/hydrate";
import { formatRange, validateAssignment, type Violation } from "@/rules";

/**
 * Shift swaps, drops and coverage.
 *
 * ---------------------------------------------------------------------------
 * The state machine
 * ---------------------------------------------------------------------------
 *   swap:  pending_target --(target accepts)--> pending_manager --(approve)--> approved
 *   drop:  open           --(someone claims)--> pending_manager --(approve)--> approved
 *
 *   terminal: rejected | cancelled | withdrawn | expired
 *
 * THE ORIGINAL ASSIGNMENT STANDS UNTIL A MANAGER APPROVES. Nothing in this file
 * moves an assignment before the approve step -- which is what makes brief
 * scenario 6 (the Regret Swap) safe: a requester who changes their mind before
 * approval simply withdraws, and nothing needs unwinding because nothing moved.
 *
 * Two guarantees live in the database rather than here, so no code path can
 * skip them:
 *   - the cap of 3 pending requests per person (trigger, self-locking)
 *   - cancellation of pending requests when a manager edits the shift (trigger)
 */

export type SwapOutcome =
  | { status: "created"; requestId: string }
  | { status: "updated"; requestId: string; state: string }
  | { status: "approved"; requestId: string; movedAssignmentIds: string[] }
  | { status: "rejected"; reason: string; violations?: Violation[] }
  | { status: "not_found"; message: string };

interface RequestRow {
  id: string;
  kind: "swap" | "drop";
  state: string;
  requesterId: string;
  requesterAssignmentId: string;
  targetStaffId: string | null;
  counterAssignmentId: string | null;
  claimedBy: string | null;
  expiresAt: Date | null;
  shiftId: string;
  locationId: string;
  locationName: string;
  locationTimezone: string;
  startsAt: Date;
  endsAt: Date;
}

const PENDING_STATES = ["pending_target", "open", "pending_manager"];

async function loadRequest(db: Tx | typeof sql, requestId: string): Promise<RequestRow | null> {
  const [row] = await db<RequestRow[]>`
    select sr.id,
           sr.kind,
           sr.state::text                as state,
           sr.requester_id               as "requesterId",
           sr.requester_assignment_id    as "requesterAssignmentId",
           sr.target_staff_id            as "targetStaffId",
           sr.counter_assignment_id      as "counterAssignmentId",
           sr.claimed_by                 as "claimedBy",
           sr.expires_at                 as "expiresAt",
           a.shift_id                    as "shiftId",
           s.location_id                 as "locationId",
           l.name                        as "locationName",
           l.timezone                    as "locationTimezone",
           a.starts_at                   as "startsAt",
           a.ends_at                     as "endsAt"
      from swap_requests sr
      join assignments a on a.id = sr.requester_assignment_id
      join shifts      s on s.id = a.shift_id
      join locations   l on l.id = s.location_id
     where sr.id = ${requestId}
  `;
  return row ?? null;
}

const describe = (row: Pick<RequestRow, "locationName" | "startsAt" | "endsAt" | "locationTimezone">) =>
  `${row.locationName}, ${formatRange(row.startsAt.getTime(), row.endsAt.getTime(), row.locationTimezone)}`;

/** A request is only actionable while pending AND not past its expiry. */
function isLive(row: RequestRow): boolean {
  if (!PENDING_STATES.includes(row.state)) return false;
  return row.expiresAt === null || row.expiresAt.getTime() > Date.now();
}

// ---------------------------------------------------------------------------
// Opening a request
// ---------------------------------------------------------------------------

export async function requestSwap(params: {
  requesterId: string;
  assignmentId: string;
  targetStaffId: string;
  /** Optional: the target's assignment the requester wants in return (a true trade). */
  counterAssignmentId?: string;
}): Promise<SwapOutcome> {
  return openRequest({
    ...params,
    kind: "swap",
  });
}

export async function requestDrop(params: {
  requesterId: string;
  assignmentId: string;
}): Promise<SwapOutcome> {
  return openRequest({ ...params, kind: "drop" });
}

async function openRequest(params: {
  kind: "swap" | "drop";
  requesterId: string;
  assignmentId: string;
  targetStaffId?: string;
  counterAssignmentId?: string;
}): Promise<SwapOutcome> {
  try {
    return await withStaffLock(params.requesterId, [params.requesterId], async (tx) => {
      const [assignment] = await tx<
        {
          staffId: string;
          status: string;
          startsAt: Date;
          endsAt: Date;
          locationId: string;
          locationName: string;
          locationTimezone: string;
        }[]
      >`
        select a.staff_id as "staffId", a.status::text as status,
               a.starts_at as "startsAt", a.ends_at as "endsAt",
               s.location_id as "locationId", l.name as "locationName",
               l.timezone as "locationTimezone"
          from assignments a
          join shifts s    on s.id = a.shift_id
          join locations l on l.id = s.location_id
         where a.id = ${params.assignmentId}
      `;

      if (!assignment) {
        return { status: "not_found", message: "Assignment not found." } as const;
      }
      if (assignment.staffId !== params.requesterId) {
        return {
          status: "rejected",
          reason: "You can only offer up a shift you are assigned to.",
        } as const;
      }
      if (assignment.status !== "active") {
        return { status: "rejected", reason: "That shift is no longer assigned to you." } as const;
      }
      if (assignment.startsAt.getTime() <= Date.now()) {
        return { status: "rejected", reason: "That shift has already started." } as const;
      }

      // Only one live request per assignment: two competing offers for the same
      // shift would let two different people each believe they had it.
      const [existing] = await tx<{ id: string }[]>`
        select id from swap_requests
         where requester_assignment_id = ${params.assignmentId}
           and state::text = any(${PENDING_STATES})
           and (expires_at is null or expires_at > now())
      `;
      if (existing) {
        return {
          status: "rejected",
          reason: "There is already an open request for this shift.",
        } as const;
      }

      const settings = await loadSettings(tx);

      // A drop expires 24h before the shift. Reads filter on this too, so the
      // rule holds even if the sweeper never runs.
      const expiresAt =
        params.kind === "drop"
          ? new Date(assignment.startsAt.getTime() - settings.dropExpiryHours * 3_600_000)
          : null;

      if (expiresAt && expiresAt.getTime() <= Date.now()) {
        return {
          status: "rejected",
          reason:
            `This shift starts within ${settings.dropExpiryHours} hours, so it is too late to ` +
            `offer it up. Contact your manager directly.`,
        } as const;
      }

      const [request] = await tx<{ id: string }[]>`
        insert into swap_requests (
          kind, state, requester_id, requester_assignment_id,
          target_staff_id, counter_assignment_id, expires_at
        )
        values (
          ${params.kind},
          ${params.kind === "swap" ? "pending_target" : "open"},
          ${params.requesterId},
          ${params.assignmentId},
          ${params.targetStaffId ?? null},
          ${params.counterAssignmentId ?? null},
          ${expiresAt}
        )
        returning id
      `;

      const shiftLabel = describe(assignment);

      if (params.kind === "swap" && params.targetStaffId) {
        await notify(tx, {
          recipientId: params.targetStaffId,
          kind: "swap_requested",
          title: "A colleague asked you to take a shift",
          body: `You have been asked to cover ${shiftLabel}.`,
          entityType: "swap_requests",
          entityId: request.id,
        });
      } else {
        // An open drop is broadcast to everyone qualified to claim it.
        const eligible = await tx<{ id: string }[]>`
          select p.id from profiles p
            join staff_skills ss on ss.staff_id = p.id
            join shifts s on s.id = (select shift_id from assignments where id = ${params.assignmentId})
           where p.is_active
             and p.id <> ${params.requesterId}
             and ss.skill_id = s.required_skill_id
             and is_certified_on(p.id, s.location_id,
                   (s.starts_at at time zone ${assignment.locationTimezone})::date)
        `;
        for (const person of eligible) {
          await notify(tx, {
            recipientId: person.id,
            kind: "drop_offered",
            title: "A shift is available to pick up",
            body: `${shiftLabel} is available.`,
            entityType: "swap_requests",
            entityId: request.id,
          });
        }
      }

      return { status: "created", requestId: request.id } as const;
    });
  } catch (error) {
    // The pending-request cap is a database trigger, so its message is already
    // written for a human.
    if (
      isPgError(error, PG_ERRORS.CHECK_VIOLATION) ||
      isPgError(error, PG_ERRORS.RAISE_EXCEPTION)
    ) {
      return {
        status: "rejected",
        reason: (error as { message?: string }).message ?? "Request refused.",
      };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Responding
// ---------------------------------------------------------------------------

export async function respondToSwap(params: {
  targetStaffId: string;
  requestId: string;
  accept: boolean;
  note?: string;
}): Promise<SwapOutcome> {
  return withStaffLock(params.targetStaffId, [params.targetStaffId], async (tx) => {
    const request = await loadRequest(tx, params.requestId);
    if (!request) return { status: "not_found", message: "Request not found." } as const;

    if (request.targetStaffId !== params.targetStaffId) {
      return { status: "rejected", reason: "This request was not addressed to you." } as const;
    }
    if (request.state !== "pending_target" || !isLive(request)) {
      return {
        status: "rejected",
        reason: "This request is no longer awaiting your response.",
      } as const;
    }

    const nextState = params.accept ? "pending_manager" : "rejected";

    await tx`
      update swap_requests
         set state = ${nextState}::swap_state,
             resolution_note = ${params.note ?? null},
             resolved_by = ${params.accept ? null : params.targetStaffId},
             resolved_at = ${params.accept ? null : new Date()}
       where id = ${params.requestId}
    `;

    await notify(tx, {
      recipientId: request.requesterId,
      kind: params.accept ? "swap_accepted" : "swap_rejected",
      title: params.accept ? "Your swap was accepted" : "Your swap was declined",
      body: params.accept
        ? `Your request for ${describe(request)} now needs manager approval. You remain assigned until then.`
        : `Your request for ${describe(request)} was declined.`,
      entityType: "swap_requests",
      entityId: request.id,
    });

    if (params.accept) {
      for (const managerId of await managersOfLocation(tx, request.locationId)) {
        await notify(tx, {
          recipientId: managerId,
          kind: "approval_needed",
          title: "A swap needs your approval",
          body: `A swap for ${describe(request)} is awaiting approval.`,
          entityType: "swap_requests",
          entityId: request.id,
        });
      }
    }

    return { status: "updated", requestId: request.id, state: nextState } as const;
  });
}

/** Pick up an open drop. First qualified claim wins. */
export async function claimDrop(params: {
  claimantId: string;
  requestId: string;
}): Promise<SwapOutcome> {
  return withStaffLock(params.claimantId, [params.claimantId], async (tx) => {
    const request = await loadRequest(tx, params.requestId);
    if (!request) return { status: "not_found", message: "Request not found." } as const;

    if (request.kind !== "drop" || request.state !== "open") {
      return { status: "rejected", reason: "This shift is no longer available." } as const;
    }
    if (!isLive(request)) {
      return {
        status: "rejected",
        reason: "This offer expired 24 hours before the shift and can no longer be claimed.",
      } as const;
    }
    if (request.claimedBy) {
      return { status: "rejected", reason: "Someone else has already claimed this shift." } as const;
    }

    // Check the claimant could actually work it, before involving a manager.
    const blocking = await validateTransfer(tx, {
      staffId: params.claimantId,
      shiftId: request.shiftId,
      excludeAssignmentIds: [],
      replacingAssignmentId: request.requesterAssignmentId,
    });
    if (blocking.length > 0) {
      return {
        status: "rejected",
        reason: "You are not able to take this shift.",
        violations: blocking,
      } as const;
    }

    // The WHERE clause re-checks state, so two simultaneous claims cannot both
    // succeed: the second updates zero rows.
    const claimed = await tx`
      update swap_requests
         set state = 'pending_manager', claimed_by = ${params.claimantId}, claimed_at = now()
       where id = ${params.requestId} and state = 'open' and claimed_by is null
      returning id
    `;
    if (claimed.length === 0) {
      return { status: "rejected", reason: "Someone else claimed this shift first." } as const;
    }

    await notify(tx, {
      recipientId: request.requesterId,
      kind: "drop_claimed",
      title: "Someone picked up your shift",
      body: `${describe(request)} was claimed and now needs manager approval. You remain assigned until then.`,
      entityType: "swap_requests",
      entityId: request.id,
    });

    for (const managerId of await managersOfLocation(tx, request.locationId)) {
      await notify(tx, {
        recipientId: managerId,
        kind: "approval_needed",
        title: "A shift pickup needs your approval",
        body: `A pickup for ${describe(request)} is awaiting approval.`,
        entityType: "swap_requests",
        entityId: request.id,
      });
    }

    return { status: "updated", requestId: request.id, state: "pending_manager" } as const;
  });
}

/**
 * Brief scenario 6 -- the Regret Swap.
 *
 * The requester changes their mind before a manager has approved. Because the
 * original assignment never moved, withdrawal is clean: mark the request
 * withdrawn, tell the counterparty and the manager, and nothing else changes.
 * No penalty is applied -- the withdrawal is audit-logged, and it frees one of
 * the requester's three pending slots.
 */
export async function withdrawRequest(params: {
  requesterId: string;
  requestId: string;
  note?: string;
}): Promise<SwapOutcome> {
  return withStaffLock(params.requesterId, [params.requesterId], async (tx) => {
    const request = await loadRequest(tx, params.requestId);
    if (!request) return { status: "not_found", message: "Request not found." } as const;

    if (request.requesterId !== params.requesterId) {
      return { status: "rejected", reason: "This is not your request." } as const;
    }
    if (!PENDING_STATES.includes(request.state)) {
      return {
        status: "rejected",
        reason:
          request.state === "approved"
            ? "This swap has already been approved. Ask your manager to reverse it."
            : "This request is already closed.",
      } as const;
    }

    await tx`
      update swap_requests
         set state = 'withdrawn',
             resolution_note = ${params.note ?? "Withdrawn by the requester"},
             resolved_by = ${params.requesterId},
             resolved_at = now()
       where id = ${params.requestId}
    `;

    const counterparty = request.claimedBy ?? request.targetStaffId;
    if (counterparty) {
      await notify(tx, {
        recipientId: counterparty,
        kind: "swap_withdrawn",
        title: "A swap request was withdrawn",
        body: `The request for ${describe(request)} was withdrawn. You are not scheduled for it.`,
        entityType: "swap_requests",
        entityId: request.id,
      });
    }

    // Only bother managers who were actually asked to act.
    if (request.state === "pending_manager") {
      for (const managerId of await managersOfLocation(tx, request.locationId)) {
        await notify(tx, {
          recipientId: managerId,
          kind: "swap_withdrawn",
          title: "A swap awaiting your approval was withdrawn",
          body: `The request for ${describe(request)} no longer needs your approval.`,
          entityType: "swap_requests",
          entityId: request.id,
        });
      }
    }

    return { status: "updated", requestId: request.id, state: "withdrawn" } as const;
  });
}

// ---------------------------------------------------------------------------
// Manager decision -- the only step that moves an assignment
// ---------------------------------------------------------------------------

export async function decideRequest(params: {
  managerId: string;
  requestId: string;
  approve: boolean;
  note?: string;
}): Promise<SwapOutcome> {
  const preview = await loadRequest(sql, params.requestId);
  if (!preview) return { status: "not_found", message: "Request not found." };

  const incomingStaffId = preview.claimedBy ?? preview.targetStaffId;
  if (params.approve && !incomingStaffId) {
    return { status: "rejected", reason: "Nobody has agreed to take this shift yet." };
  }

  // Lock everyone whose schedule this could move.
  const affected = [preview.requesterId, incomingStaffId].filter(Boolean) as string[];

  return withStaffLock(params.managerId, affected, async (tx) => {
    const request = await loadRequest(tx, params.requestId);
    if (!request) return { status: "not_found", message: "Request not found." } as const;

    if (request.state !== "pending_manager" || !isLive(request)) {
      return { status: "rejected", reason: "This request is not awaiting approval." } as const;
    }

    if (!params.approve) {
      await tx`
        update swap_requests
           set state = 'rejected', resolution_note = ${params.note ?? null},
               resolved_by = ${params.managerId}, resolved_at = now()
         where id = ${request.id}
      `;
      for (const recipientId of affected) {
        await notify(tx, {
          recipientId,
          kind: "swap_rejected",
          title: "A swap was declined by your manager",
          body: `The change for ${describe(request)} was not approved. The original assignment stands.`,
          entityType: "swap_requests",
          entityId: request.id,
        });
      }
      return { status: "updated", requestId: request.id, state: "rejected" } as const;
    }

    const newStaffId = incomingStaffId!;

    // Re-validate at the moment of approval, not at the moment of request. Days
    // may have passed; the incoming person's schedule has probably changed.
    // Their outgoing assignment is excluded so a genuine trade is not mistaken
    // for a double-booking.
    const excludeForIncoming = request.counterAssignmentId ? [request.counterAssignmentId] : [];

    const incomingViolations = await validateTransfer(tx, {
      staffId: newStaffId,
      shiftId: request.shiftId,
      excludeAssignmentIds: excludeForIncoming,
      replacingAssignmentId: request.requesterAssignmentId,
    });

    if (incomingViolations.length > 0) {
      return {
        status: "rejected",
        reason: "This swap can no longer be approved.",
        violations: incomingViolations,
      } as const;
    }

    let counterShiftId: string | null = null;
    if (request.counterAssignmentId) {
      const [counter] = await tx<{ shiftId: string }[]>`
        select shift_id as "shiftId" from assignments where id = ${request.counterAssignmentId}
      `;
      counterShiftId = counter?.shiftId ?? null;

      if (counterShiftId) {
        const requesterViolations = await validateTransfer(tx, {
          staffId: request.requesterId,
          shiftId: counterShiftId,
          excludeAssignmentIds: [request.requesterAssignmentId],
          replacingAssignmentId: request.counterAssignmentId,
        });
        if (requesterViolations.length > 0) {
          return {
            status: "rejected",
            reason: "This swap can no longer be approved.",
            violations: requesterViolations,
          } as const;
        }
      }
    }

    // Release before inserting. For a mutual trade both sides must vacate first,
    // or the exclusion constraint would refuse the very swap being approved.
    await tx`
      update assignments set status = 'released', released_at = now()
       where id = ${request.requesterAssignmentId} and status = 'active'
    `;
    if (request.counterAssignmentId) {
      await tx`
        update assignments set status = 'released', released_at = now()
         where id = ${request.counterAssignmentId} and status = 'active'
      `;
    }

    const moved: string[] = [];

    const [taken] = await tx<{ id: string }[]>`
      insert into assignments (shift_id, staff_id, assigned_by)
      values (${request.shiftId}, ${newStaffId}, ${params.managerId})
      returning id
    `;
    moved.push(taken.id);

    if (counterShiftId) {
      const [returned] = await tx<{ id: string }[]>`
        insert into assignments (shift_id, staff_id, assigned_by)
        values (${counterShiftId}, ${request.requesterId}, ${params.managerId})
        returning id
      `;
      moved.push(returned.id);
    }

    await tx`
      update swap_requests
         set state = 'approved', resolution_note = ${params.note ?? null},
             resolved_by = ${params.managerId}, resolved_at = now()
       where id = ${request.id}
    `;

    for (const recipientId of affected) {
      await notify(tx, {
        recipientId,
        kind: "swap_approved",
        title: "A swap was approved",
        body: `The change for ${describe(request)} is now in effect.`,
        entityType: "swap_requests",
        entityId: request.id,
      });
    }

    return { status: "approved", requestId: request.id, movedAssignmentIds: moved } as const;
  });
}

/**
 * Would this person be allowed to take this shift? Blocking violations only.
 *
 * `replacingAssignmentId` matters more than it looks. A coverage transfer is a
 * REPLACEMENT, not an addition: the outgoing person still occupies their seat
 * at the moment of validation, so on a headcount-1 shift the incoming person
 * would otherwise be refused for SHIFT_FULL -- making every swap unapprovable.
 * Discounting the seat about to be vacated is what models the transfer honestly.
 */
async function validateTransfer(
  tx: Tx,
  options: {
    staffId: string;
    shiftId: string;
    excludeAssignmentIds: string[];
    replacingAssignmentId?: string | null;
  },
): Promise<Violation[]> {
  const [settings, shift, staff] = await Promise.all([
    loadSettings(tx),
    loadShiftSnapshot(tx, options.shiftId),
    loadStaffSnapshot(tx, options.staffId),
  ]);

  if (!shift || !staff) {
    return [
      {
        code: "NOT_CERTIFIED",
        severity: "block",
        message: "The shift or staff member no longer exists.",
      },
    ];
  }

  if (options.replacingAssignmentId) {
    const [vacating] = await tx<{ id: string }[]>`
      select id from assignments
       where id = ${options.replacingAssignmentId}
         and shift_id = ${options.shiftId}
         and status = 'active'
    `;
    if (vacating) shift.filledCount -= 1;
  }

  const existing = await loadExistingAssignments(tx, {
    staffId: options.staffId,
    aroundStart: shift.startsAt,
    aroundEnd: shift.endsAt,
    excludeAssignmentIds: options.excludeAssignmentIds,
  });

  const result = validateAssignment({ staff, shift, existing, settings });

  // The edit cutoff governs a manager rewriting the schedule, not a member of
  // staff arranging their own cover -- coverage inside the cutoff is precisely
  // what the swap flow exists for.
  return result.violations.filter((v) => v.severity === "block" && v.code !== "SHIFT_LOCKED");
}

/** Expire unclaimed drops. Notifications only -- reads already filter by expiry. */
export async function expireStaleRequests(): Promise<number> {
  const expiring = await sql<
    { id: string; requesterId: string; locationName: string; locationTimezone: string;
      startsAt: Date; endsAt: Date }[]
  >`
    select sr.id, sr.requester_id as "requesterId", l.name as "locationName",
           l.timezone as "locationTimezone", a.starts_at as "startsAt", a.ends_at as "endsAt"
      from swap_requests sr
      join assignments a on a.id = sr.requester_assignment_id
      join shifts s      on s.id = a.shift_id
      join locations l   on l.id = s.location_id
     where sr.state::text = any(${PENDING_STATES})
       and sr.expires_at is not null
       and sr.expires_at <= now()
  `;

  if (expiring.length === 0) return 0;

  await sql.begin(async (tx) => {
    await tx`select expire_stale_requests()`;
    for (const row of expiring) {
      await notify(tx as Tx, {
        recipientId: row.requesterId,
        kind: "drop_expired",
        title: "Nobody picked up your shift",
        body: `${describe(row)} was not claimed, so you are still scheduled for it.`,
        entityType: "swap_requests",
        entityId: row.id,
      });
    }
  });

  return expiring.length;
}
