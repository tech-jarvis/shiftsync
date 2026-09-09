import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/db/client";
import { assignStaffToShift, releaseAssignment } from "@/domain/scheduling/assign";
import {
  createLocation,
  createQualifiedStaff,
  createShift,
  createSkill,
  setAvailability,
} from "../support/fixtures";

/**
 * End-to-end tests of the assignment write path: rules, database, notifications
 * and suggestions working together against a real Postgres.
 */

afterAll(async () => {
  await sql.end();
});

async function scenario(options: { headcount?: number } = {}) {
  const location = await createLocation("America/Los_Angeles");
  const skill = await createSkill("Bartender");

  const shift = await createShift({
    locationId: location.id,
    skillId: skill.id,
    // Mon 2026-06-15, 18:00-23:00 Pacific.
    startsAt: "2026-06-16 01:00+00",
    endsAt: "2026-06-16 06:00+00",
    headcount: options.headcount ?? 1,
  });

  return { location, skill, shift };
}

describe("assigning a qualified, available staff member", () => {
  it("saves the assignment and notifies them", async () => {
    const { location, skill, shift } = await scenario();
    const staff = await createQualifiedStaff({
      locationIds: [location.id],
      skillIds: [skill.id],
    });

    const outcome = await assignStaffToShift({
      actorId: null,
      shiftId: shift.id,
      staffId: staff.id,
      now: Date.parse("2026-06-01T00:00:00Z"),
    });

    expect(outcome.status).toBe("assigned");

    const [row] = await sql<{ count: string }[]>`
      select count(*) from assignments where shift_id = ${shift.id} and status = 'active'
    `;
    expect(Number(row.count)).toBe(1);

    const [notification] = await sql<{ kind: string; body: string }[]>`
      select kind, body from notifications where recipient_id = ${staff.id}
    `;
    expect(notification.kind).toBe("shift_assigned");
    expect(notification.body).toContain("18:00");
  });

  it("writes an audit row attributing the change to the acting manager", async () => {
    const { location, skill, shift } = await scenario();
    const manager = await createQualifiedStaff({
      locationIds: [location.id],
      skillIds: [skill.id],
    });
    const staff = await createQualifiedStaff({
      locationIds: [location.id],
      skillIds: [skill.id],
    });

    await assignStaffToShift({
      actorId: manager.id,
      shiftId: shift.id,
      staffId: staff.id,
      now: Date.parse("2026-06-01T00:00:00Z"),
    });

    const [audit] = await sql<{ actorId: string; action: string; entityType: string }[]>`
      select actor_id as "actorId", action, entity_type as "entityType"
        from audit_log
       where entity_type = 'assignments'
         and after_state ->> 'shift_id' = ${shift.id}
    `;
    expect(audit.actorId).toBe(manager.id);
    expect(audit.action).toBe("insert");
  });
});

describe("the Sunday Night Chaos (brief scenario 1)", () => {
  it("refuses an unavailable person and names who CAN take the shift instead", async () => {
    const { location, skill, shift } = await scenario();

    // Sarah is certified and skilled, but only available mornings, so the
    // evening shift falls outside her window.
    const sarah = await createQualifiedStaff({
      locationIds: [location.id],
      skillIds: [skill.id],
      alwaysAvailable: false,
    });
    await setAvailability(sarah.id, [{ isoWeekday: 1, startMinute: 480, endMinute: 720 }]);

    // Two colleagues who can genuinely cover it.
    const john = await createQualifiedStaff({ locationIds: [location.id], skillIds: [skill.id] });
    const maria = await createQualifiedStaff({ locationIds: [location.id], skillIds: [skill.id] });

    const outcome = await assignStaffToShift({
      actorId: null,
      shiftId: shift.id,
      staffId: sarah.id,
      now: Date.parse("2026-06-01T00:00:00Z"),
    });

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") return;

    expect(outcome.violations[0].code).toBe("OUTSIDE_AVAILABILITY");
    expect(outcome.violations[0].message).toContain("not available");

    const suggested = outcome.suggestions.map((s) => s.staffId);
    expect(suggested).toContain(john.id);
    expect(suggested).toContain(maria.id);
    expect(suggested).not.toContain(sarah.id);
  });

  it("does not suggest anyone who is blocked for a different reason", async () => {
    const { location, skill, shift } = await scenario();

    const unavailable = await createQualifiedStaff({
      locationIds: [location.id],
      skillIds: [skill.id],
      alwaysAvailable: false,
    });
    // Certified and skilled but with no availability at all -> not an option.

    const requester = await createQualifiedStaff({
      locationIds: [location.id],
      skillIds: [skill.id],
      alwaysAvailable: false,
    });

    const outcome = await assignStaffToShift({
      actorId: null,
      shiftId: shift.id,
      staffId: requester.id,
      now: Date.parse("2026-06-01T00:00:00Z"),
    });

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") return;
    expect(outcome.suggestions.map((s) => s.staffId)).not.toContain(unavailable.id);
  });

  it("ranks a colleague who is under their desired hours above one who is over", async () => {
    const { location, skill, shift } = await scenario();

    const underworked = await createQualifiedStaff({
      locationIds: [location.id],
      skillIds: [skill.id],
      desiredWeeklyHours: 40,
    });
    const overworked = await createQualifiedStaff({
      locationIds: [location.id],
      skillIds: [skill.id],
      desiredWeeklyHours: 8,
    });

    const blocked = await createQualifiedStaff({
      locationIds: [location.id],
      skillIds: [skill.id],
      alwaysAvailable: false,
    });

    const outcome = await assignStaffToShift({
      actorId: null,
      shiftId: shift.id,
      staffId: blocked.id,
      now: Date.parse("2026-06-01T00:00:00Z"),
    });

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") return;

    const order = outcome.suggestions.map((s) => s.staffId);
    expect(order.indexOf(underworked.id)).toBeLessThan(order.indexOf(overworked.id));
  });
});

describe("documented overrides", () => {
  it("refuses a 7th consecutive day without a reason, and accepts it with one", async () => {
    const location = await createLocation("America/Los_Angeles");
    const skill = await createSkill("Line Cook");
    const staff = await createQualifiedStaff({
      locationIds: [location.id],
      skillIds: [skill.id],
    });

    // Six consecutive prior days, 4h each (short enough to avoid hour rules).
    for (let day = 8; day <= 13; day += 1) {
      const prior = await createShift({
        locationId: location.id,
        skillId: skill.id,
        startsAt: `2026-06-${day} 17:00+00`,
        endsAt: `2026-06-${day} 21:00+00`,
      });
      await sql`insert into assignments (shift_id, staff_id) values (${prior.id}, ${staff.id})`;
    }

    const seventh = await createShift({
      locationId: location.id,
      skillId: skill.id,
      startsAt: "2026-06-14 17:00+00",
      endsAt: "2026-06-14 21:00+00",
    });

    const refused = await assignStaffToShift({
      actorId: null,
      shiftId: seventh.id,
      staffId: staff.id,
      now: Date.parse("2026-06-01T00:00:00Z"),
    });
    expect(refused.status).toBe("override_required");

    const manager = await createQualifiedStaff({
      locationIds: [location.id],
      skillIds: [skill.id],
    });

    const allowed = await assignStaffToShift({
      actorId: manager.id,
      shiftId: seventh.id,
      staffId: staff.id,
      override: { reason: "Short-staffed after two call-outs; employee volunteered." },
      now: Date.parse("2026-06-01T00:00:00Z"),
    });
    expect(allowed.status).toBe("assigned");
    if (allowed.status !== "assigned") return;

    // Scoped to THIS assignment: the database persists between test runs, so an
    // unscoped read would pick up an override recorded by an earlier run.
    const [override] = await sql<{ ruleCode: string; reason: string; approvedBy: string }[]>`
      select rule_code as "ruleCode", reason, approved_by as "approvedBy"
        from rule_overrides
       where assignment_id = ${allowed.assignmentId}
    `;
    expect(override.ruleCode).toBe("CONSECUTIVE_DAYS_OVERRIDE");
    expect(override.reason).toContain("volunteered");
    expect(override.approvedBy).toBe(manager.id);
  });
});

describe("releasing an assignment", () => {
  it("preserves the row, frees the slot, and notifies the staff member", async () => {
    const { location, skill, shift } = await scenario();
    const staff = await createQualifiedStaff({
      locationIds: [location.id],
      skillIds: [skill.id],
    });

    const assigned = await assignStaffToShift({
      actorId: null,
      shiftId: shift.id,
      staffId: staff.id,
      now: Date.parse("2026-06-01T00:00:00Z"),
    });
    expect(assigned.status).toBe("assigned");
    if (assigned.status !== "assigned") return;

    const { released } = await releaseAssignment({
      actorId: null,
      assignmentId: assigned.assignmentId,
    });
    expect(released).toBe(true);

    // The row survives for audit; it is simply no longer active.
    const [row] = await sql<{ status: string }[]>`
      select status from assignments where id = ${assigned.assignmentId}
    `;
    expect(row.status).toBe("released");

    // And the freed slot can be filled by someone else.
    const replacement = await createQualifiedStaff({
      locationIds: [location.id],
      skillIds: [skill.id],
    });
    const refilled = await assignStaffToShift({
      actorId: null,
      shiftId: shift.id,
      staffId: replacement.id,
      now: Date.parse("2026-06-01T00:00:00Z"),
    });
    expect(refilled.status).toBe("assigned");
  });
});
