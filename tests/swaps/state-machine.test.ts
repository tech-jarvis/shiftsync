import { DateTime } from "luxon";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/db/client";
import {
  claimDrop,
  decideRequest,
  requestDrop,
  requestSwap,
  respondToSwap,
  withdrawRequest,
} from "@/domain/swaps/service";
import {
  assign,
  createLocation,
  createQualifiedStaff,
  createShift,
  createSkill,
  setAvailability,
} from "../support/fixtures";

/**
 * The swap / drop / coverage state machine, including every edge case the brief
 * calls out explicitly.
 */

afterAll(async () => {
  await sql.end();
});

/** Shifts must be in the future for request rules (and drop expiry) to apply. */
const inDays = (days: number, hour: number) =>
  DateTime.now().setZone("utc").plus({ days }).set({ hour, minute: 0, second: 0, millisecond: 0 });

async function coverageSetup(options: { daysAhead?: number } = {}) {
  const daysAhead = options.daysAhead ?? 10;
  const location = await createLocation("America/Los_Angeles");
  const skill = await createSkill("Bartender");

  const [alice, bob, carol] = await Promise.all([
    createQualifiedStaff({ locationIds: [location.id], skillIds: [skill.id] }),
    createQualifiedStaff({ locationIds: [location.id], skillIds: [skill.id] }),
    createQualifiedStaff({ locationIds: [location.id], skillIds: [skill.id] }),
  ]);

  const manager = await createQualifiedStaff({ locationIds: [location.id], skillIds: [skill.id] });
  await sql`insert into manager_locations (manager_id, location_id)
            values (${manager.id}, ${location.id})`;

  const shift = await createShift({
    locationId: location.id,
    skillId: skill.id,
    startsAt: inDays(daysAhead, 18).toISO()!,
    endsAt: inDays(daysAhead, 23).toISO()!,
    isPublished: true,
  });

  const assignment = await assign(shift.id, alice.id);

  return { location, skill, alice, bob, carol, manager, shift, assignment };
}

const stateOf = async (requestId: string) => {
  const [row] = await sql<{ state: string }[]>`
    select state::text as state from swap_requests where id = ${requestId}
  `;
  return row.state;
};

const assignmentStatus = async (assignmentId: string) => {
  const [row] = await sql<{ status: string }[]>`
    select status::text as status from assignments where id = ${assignmentId}
  `;
  return row.status;
};

describe("the full swap lifecycle", () => {
  it("holds the original assignment until the manager approves", async () => {
    const { alice, bob, manager, assignment } = await coverageSetup();

    const created = await requestSwap({
      requesterId: alice.id,
      assignmentId: assignment.id,
      targetStaffId: bob.id,
    });
    expect(created.status).toBe("created");
    if (created.status !== "created") return;

    // Requested: Alice still works it.
    expect(await stateOf(created.requestId)).toBe("pending_target");
    expect(await assignmentStatus(assignment.id)).toBe("active");

    // Accepted by Bob: Alice STILL works it. This is the guarantee the brief
    // asks for -- acceptance is not a transfer.
    await respondToSwap({ targetStaffId: bob.id, requestId: created.requestId, accept: true });
    expect(await stateOf(created.requestId)).toBe("pending_manager");
    expect(await assignmentStatus(assignment.id)).toBe("active");

    // Approved: only now does it move.
    const decided = await decideRequest({
      managerId: manager.id,
      requestId: created.requestId,
      approve: true,
    });
    expect(decided.status).toBe("approved");
    expect(await assignmentStatus(assignment.id)).toBe("released");

    const [now] = await sql<{ staffId: string }[]>`
      select staff_id as "staffId" from assignments
       where shift_id = (select shift_id from assignments where id = ${assignment.id})
         and status = 'active'
    `;
    expect(now.staffId).toBe(bob.id);
  });

  it("notifies every party at each step", async () => {
    const { alice, bob, manager, assignment } = await coverageSetup();

    const created = await requestSwap({
      requesterId: alice.id,
      assignmentId: assignment.id,
      targetStaffId: bob.id,
    });
    if (created.status !== "created") throw new Error("setup failed");

    await respondToSwap({ targetStaffId: bob.id, requestId: created.requestId, accept: true });
    await decideRequest({ managerId: manager.id, requestId: created.requestId, approve: true });

    const kinds = await sql<{ recipientId: string; kind: string }[]>`
      select recipient_id as "recipientId", kind from notifications
       where entity_id = ${created.requestId} order by created_at
    `;

    expect(kinds.filter((k) => k.recipientId === bob.id).map((k) => k.kind))
      .toContain("swap_requested");
    expect(kinds.filter((k) => k.recipientId === alice.id).map((k) => k.kind))
      .toContain("swap_accepted");
    expect(kinds.filter((k) => k.recipientId === manager.id).map((k) => k.kind))
      .toContain("approval_needed");
    expect(kinds.filter((k) => k.recipientId === alice.id).map((k) => k.kind))
      .toContain("swap_approved");
  });

  it("leaves the original assignment untouched when a manager declines", async () => {
    const { alice, bob, manager, assignment } = await coverageSetup();

    const created = await requestSwap({
      requesterId: alice.id,
      assignmentId: assignment.id,
      targetStaffId: bob.id,
    });
    if (created.status !== "created") throw new Error("setup failed");

    await respondToSwap({ targetStaffId: bob.id, requestId: created.requestId, accept: true });
    await decideRequest({ managerId: manager.id, requestId: created.requestId, approve: false });

    expect(await stateOf(created.requestId)).toBe("rejected");
    expect(await assignmentStatus(assignment.id)).toBe("active");
  });
});

describe("the Regret Swap (brief scenario 6)", () => {
  it("lets the requester withdraw before approval, with nothing to unwind", async () => {
    const { alice, bob, assignment } = await coverageSetup();

    const created = await requestSwap({
      requesterId: alice.id,
      assignmentId: assignment.id,
      targetStaffId: bob.id,
    });
    if (created.status !== "created") throw new Error("setup failed");

    await respondToSwap({ targetStaffId: bob.id, requestId: created.requestId, accept: true });

    // Alice changes her mind. Because the assignment never moved, this is clean.
    const withdrawn = await withdrawRequest({
      requesterId: alice.id,
      requestId: created.requestId,
      note: "Childcare sorted itself out",
    });
    expect(withdrawn.status).toBe("updated");
    expect(await stateOf(created.requestId)).toBe("withdrawn");
    expect(await assignmentStatus(assignment.id)).toBe("active");

    // Bob is told he is not scheduled for it.
    const [notice] = await sql<{ kind: string; body: string }[]>`
      select kind, body from notifications
       where recipient_id = ${bob.id} and entity_id = ${created.requestId}
         and kind = 'swap_withdrawn'
    `;
    expect(notice.body).toContain("not scheduled");
  });

  it("frees a pending slot, so withdrawing is not punished", async () => {
    const { alice, bob, assignment } = await coverageSetup();
    const created = await requestSwap({
      requesterId: alice.id,
      assignmentId: assignment.id,
      targetStaffId: bob.id,
    });
    if (created.status !== "created") throw new Error("setup failed");

    await withdrawRequest({ requesterId: alice.id, requestId: created.requestId });

    const [{ count }] = await sql<{ count: string }[]>`
      select count(*) from swap_requests
       where requester_id = ${alice.id}
         and state::text = any(array['pending_target','open','pending_manager'])
    `;
    expect(Number(count)).toBe(0);
  });

  it("refuses to withdraw a swap the manager already approved", async () => {
    const { alice, bob, manager, assignment } = await coverageSetup();
    const created = await requestSwap({
      requesterId: alice.id,
      assignmentId: assignment.id,
      targetStaffId: bob.id,
    });
    if (created.status !== "created") throw new Error("setup failed");

    await respondToSwap({ targetStaffId: bob.id, requestId: created.requestId, accept: true });
    await decideRequest({ managerId: manager.id, requestId: created.requestId, approve: true });

    const late = await withdrawRequest({ requesterId: alice.id, requestId: created.requestId });
    expect(late.status).toBe("rejected");
    if (late.status !== "rejected") return;
    expect(late.reason).toContain("already been approved");
  });
});

describe("drop requests", () => {
  it("offers a shift to everyone qualified, and the first claim wins", async () => {
    const { alice, bob, carol, assignment } = await coverageSetup();

    const created = await requestDrop({ requesterId: alice.id, assignmentId: assignment.id });
    expect(created.status).toBe("created");
    if (created.status !== "created") return;
    expect(await stateOf(created.requestId)).toBe("open");

    // Both Bob and Carol were notified it was available.
    const notified = await sql<{ recipientId: string }[]>`
      select recipient_id as "recipientId" from notifications
       where entity_id = ${created.requestId} and kind = 'drop_offered'
    `;
    const recipients = notified.map((n) => n.recipientId);
    expect(recipients).toContain(bob.id);
    expect(recipients).toContain(carol.id);
    expect(recipients).not.toContain(alice.id);

    const first = await claimDrop({ claimantId: bob.id, requestId: created.requestId });
    expect(first.status).toBe("updated");

    const second = await claimDrop({ claimantId: carol.id, requestId: created.requestId });
    expect(second.status).toBe("rejected");
    if (second.status !== "rejected") return;
    expect(second.reason).toMatch(/already claimed|no longer available/i);
  });

  it("refuses to open a drop inside the 24h expiry window", async () => {
    // A shift 12 hours away: the offer would already have expired.
    const { alice, assignment } = await coverageSetup({ daysAhead: 0 });

    const created = await requestDrop({ requesterId: alice.id, assignmentId: assignment.id });
    expect(created.status).toBe("rejected");
    if (created.status !== "rejected") return;
    expect(created.reason).toContain("too late");
  });

  it("refuses a claim on an offer that has since expired", async () => {
    const { alice, bob, assignment, shift } = await coverageSetup();

    const created = await requestDrop({ requesterId: alice.id, assignmentId: assignment.id });
    if (created.status !== "created") throw new Error("setup failed");

    // Simulate time passing to inside the window.
    await sql`update swap_requests set expires_at = now() - interval '1 minute'
               where id = ${created.requestId}`;

    const late = await claimDrop({ claimantId: bob.id, requestId: created.requestId });
    expect(late.status).toBe("rejected");
    if (late.status !== "rejected") return;
    expect(late.reason).toContain("expired");
    expect(shift.id).toBeTruthy();
  });
});

describe("guards on opening requests", () => {
  it("refuses to offer up a shift belonging to someone else", async () => {
    const { bob, carol, assignment } = await coverageSetup();
    const outcome = await requestSwap({
      requesterId: bob.id,
      assignmentId: assignment.id,
      targetStaffId: carol.id,
    });
    expect(outcome.status).toBe("rejected");
  });

  it("allows only one live request per assignment", async () => {
    const { alice, bob, carol, assignment } = await coverageSetup();
    await requestSwap({ requesterId: alice.id, assignmentId: assignment.id, targetStaffId: bob.id });

    const second = await requestSwap({
      requesterId: alice.id,
      assignmentId: assignment.id,
      targetStaffId: carol.id,
    });
    expect(second.status).toBe("rejected");
    if (second.status !== "rejected") return;
    expect(second.reason).toContain("already an open request");
  });

  it("enforces the cap of 3 pending requests per person", async () => {
    const location = await createLocation("America/Los_Angeles");
    const skill = await createSkill("Server");
    const alice = await createQualifiedStaff({ locationIds: [location.id], skillIds: [skill.id] });
    const bob = await createQualifiedStaff({ locationIds: [location.id], skillIds: [skill.id] });

    // Four separate shifts on different days, so no rest-rule interference.
    const outcomes = [];
    for (let i = 0; i < 4; i += 1) {
      const shift = await createShift({
        locationId: location.id,
        skillId: skill.id,
        startsAt: inDays(10 + i * 2, 18).toISO()!,
        endsAt: inDays(10 + i * 2, 22).toISO()!,
        isPublished: true,
      });
      const assignment = await assign(shift.id, alice.id);
      outcomes.push(
        await requestSwap({
          requesterId: alice.id,
          assignmentId: assignment.id,
          targetStaffId: bob.id,
        }),
      );
    }

    expect(outcomes.slice(0, 3).every((o) => o.status === "created")).toBe(true);

    const fourth = outcomes[3];
    expect(fourth.status).toBe("rejected");
    if (fourth.status !== "rejected") return;
    expect(fourth.reason).toMatch(/pending swap\/drop requests/i);
  });
});

describe("a manager editing a shift cancels its pending requests", () => {
  it("cancels automatically, enforced by the database rather than the service", async () => {
    const { alice, bob, assignment, shift } = await coverageSetup();

    const created = await requestSwap({
      requesterId: alice.id,
      assignmentId: assignment.id,
      targetStaffId: bob.id,
    });
    if (created.status !== "created") throw new Error("setup failed");

    // Edit the shift directly in SQL -- bypassing the service entirely -- to
    // show the cancellation cannot be skipped by any write path.
    await sql`
      update shifts set starts_at = starts_at + interval '1 hour',
                        ends_at   = ends_at   + interval '1 hour',
                        version   = version + 1
       where id = ${shift.id}
    `;

    expect(await stateOf(created.requestId)).toBe("cancelled");

    const [row] = await sql<{ resolutionNote: string }[]>`
      select resolution_note as "resolutionNote" from swap_requests where id = ${created.requestId}
    `;
    expect(row.resolutionNote).toContain("shift was edited");
  });
});

describe("approval re-validates against the world as it is now", () => {
  it("refuses approval when the incoming person is no longer available", async () => {
    const location = await createLocation("America/Los_Angeles");
    const skill = await createSkill("Bartender");

    const alice = await createQualifiedStaff({ locationIds: [location.id], skillIds: [skill.id] });
    const bob = await createQualifiedStaff({
      locationIds: [location.id],
      skillIds: [skill.id],
      alwaysAvailable: false,
    });
    // Bob is available at the time of asking...
    await setAvailability(bob.id, [1, 2, 3, 4, 5, 6, 7].map((d) => ({
      isoWeekday: d, startMinute: 0, endMinute: 1440,
    })));

    const manager = await createQualifiedStaff({ locationIds: [location.id], skillIds: [skill.id] });
    await sql`insert into manager_locations (manager_id, location_id)
              values (${manager.id}, ${location.id})`;

    const shift = await createShift({
      locationId: location.id,
      skillId: skill.id,
      startsAt: inDays(10, 18).toISO()!,
      endsAt: inDays(10, 23).toISO()!,
      isPublished: true,
    });
    const assignment = await assign(shift.id, alice.id);

    const created = await requestSwap({
      requesterId: alice.id,
      assignmentId: assignment.id,
      targetStaffId: bob.id,
    });
    if (created.status !== "created") throw new Error("setup failed");
    await respondToSwap({ targetStaffId: bob.id, requestId: created.requestId, accept: true });

    // ...but withdraws his availability before the manager gets to it.
    await sql`delete from availability_rules where staff_id = ${bob.id}`;

    const decided = await decideRequest({
      managerId: manager.id,
      requestId: created.requestId,
      approve: true,
    });

    expect(decided.status).toBe("rejected");
    if (decided.status !== "rejected") return;
    expect(decided.violations?.[0].code).toBe("OUTSIDE_AVAILABILITY");

    // And Alice keeps the shift rather than it vanishing into a half-done swap.
    expect(await assignmentStatus(assignment.id)).toBe("active");
  });
});
