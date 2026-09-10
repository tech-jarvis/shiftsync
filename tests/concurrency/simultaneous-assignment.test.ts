import { afterAll, describe, expect, it } from "vitest";
import { isPgError, pgConstraintName, PG_ERRORS, sql } from "@/db/client";
import { withStaffLock } from "@/db/transaction";
import {
  createLocation,
  createQualifiedStaff,
  createShift,
  createSkill,
} from "../support/fixtures";

/**
 * Brief scenario 4 -- "The Simultaneous Assignment".
 *
 * Two managers at different locations both try to assign the same bartender to
 * overlapping shifts at the same moment. Exactly one must win.
 *
 * The guarantee is proved twice, at two layers, because they fail differently:
 *
 *   1. through the application's write path (advisory lock) -- the normal case
 *   2. through raw concurrent inserts with NO application locking at all --
 *      proving the invariant is structural rather than a property of our code
 *      being careful. If a future endpoint, a background job, or someone in
 *      psql forgets the lock, the database still refuses.
 */

afterAll(async () => {
  await sql.end();
});

/** Two overlapping shifts at two different locations, one qualified person. */
async function overlappingSetup() {
  const [pacific, eastern, skill] = await Promise.all([
    createLocation("America/Los_Angeles"),
    createLocation("America/New_York"),
    createSkill("Bartender"),
  ]);

  const staff = await createQualifiedStaff({
    locationIds: [pacific.id, eastern.id],
    skillIds: [skill.id],
  });

  const [shiftA, shiftB] = await Promise.all([
    createShift({
      locationId: pacific.id,
      skillId: skill.id,
      startsAt: "2026-07-10 18:00+00",
      endsAt: "2026-07-11 02:00+00",
    }),
    createShift({
      locationId: eastern.id,
      skillId: skill.id,
      startsAt: "2026-07-10 20:00+00",
      endsAt: "2026-07-11 04:00+00",
    }),
  ]);

  return { staff, shiftA, shiftB };
}

const activeCount = async (staffId: string) => {
  const [row] = await sql<{ count: string }[]>`
    select count(*) from assignments where staff_id = ${staffId} and status = 'active'
  `;
  return Number(row.count);
};

describe("two managers assigning the same person at the same instant", () => {
  it("lets exactly one commit when both go through the application write path", async () => {
    const { staff, shiftA, shiftB } = await overlappingSetup();

    const attempt = (shiftId: string) =>
      withStaffLock(null, [staff.id], async (tx) => {
        await tx`insert into assignments (shift_id, staff_id) values (${shiftId}, ${staff.id})`;
      });

    const results = await Promise.allSettled([attempt(shiftA.id), attempt(shiftB.id)]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(isPgError(rejected.reason, PG_ERRORS.EXCLUSION_VIOLATION)).toBe(true);
    expect(pgConstraintName(rejected.reason)).toBe("no_overlap_or_insufficient_rest");

    expect(await activeCount(staff.id)).toBe(1);
  });

  it(
    "still lets exactly one commit with NO application locking at all",
    async () => {
      // The important one: no advisory lock, two bare transactions genuinely in
      // flight. The invariant belongs to the schema, not to the caller's
      // discipline -- so it must hold even when nothing in our code helps.
      //
      // The race is run repeatedly rather than once. A single race samples one
      // interleaving; the guarantee is about ALL of them, and the loop is what
      // makes "both committed" hard to miss.
      //
      // ON THE TWO ERROR CODES: the loser is refused with EITHER
      // 23P01 (exclusion_violation) or 40P01 (deadlock_detected). Both are the
      // same event from different angles -- the constraint rejected the write,
      // or Postgres broke a mutual wait on the two speculative index rows by
      // aborting one. Characterised over 30 races: 23 gave 23P01, 7 gave 40P01,
      // and exactly one transaction committed every single time. Asserting only
      // 23P01 made this test flaky roughly one run in five, which is a test
      // asserting a mechanism where it meant to assert a guarantee.
      const ROUNDS = 5;

      for (let round = 0; round < ROUNDS; round += 1) {
        const { staff, shiftA, shiftB } = await overlappingSetup();

        const raceInsert = (shiftId: string) =>
          sql.begin(async (tx) => {
            await tx`insert into assignments (shift_id, staff_id) values (${shiftId}, ${staff.id})`;
            await new Promise((resolve) => setTimeout(resolve, 50));
          });

        const results = await Promise.allSettled([raceInsert(shiftA.id), raceInsert(shiftB.id)]);

        // The guarantee, stated directly.
        expect(
          results.filter((r) => r.status === "fulfilled"),
          `round ${round}: exactly one transaction must commit`,
        ).toHaveLength(1);

        const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
        const refusedByDatabase =
          isPgError(rejected.reason, PG_ERRORS.EXCLUSION_VIOLATION) ||
          isPgError(rejected.reason, PG_ERRORS.DEADLOCK_DETECTED);

        expect(
          refusedByDatabase,
          `round ${round}: loser must be refused by the database, got ` +
            `${(rejected.reason as { code?: string }).code}`,
        ).toBe(true);

        expect(await activeCount(staff.id)).toBe(1);
      }
    },
    30_000,
  );

  it("permits the second assignment once the first is released by a swap", async () => {
    // Releasing rather than deleting is what keeps history intact. The partial
    // index (WHERE status = 'active') is what stops released rows from blocking
    // the replacement.
    const { staff, shiftA, shiftB } = await overlappingSetup();

    await sql`insert into assignments (shift_id, staff_id) values (${shiftA.id}, ${staff.id})`;

    await expect(
      sql`insert into assignments (shift_id, staff_id) values (${shiftB.id}, ${staff.id})`,
    ).rejects.toMatchObject({ code: PG_ERRORS.EXCLUSION_VIOLATION });

    await sql`
      update assignments set status = 'released', released_at = now()
       where staff_id = ${staff.id} and shift_id = ${shiftA.id}
    `;

    await sql`insert into assignments (shift_id, staff_id) values (${shiftB.id}, ${staff.id})`;
    expect(await activeCount(staff.id)).toBe(1);
  });
});

describe("optimistic concurrency on shift edits", () => {
  it("refuses an edit that presents a stale version, and reports zero rows", async () => {
    const location = await createLocation();
    const skill = await createSkill();
    const shift = await createShift({
      locationId: location.id,
      skillId: skill.id,
      startsAt: "2026-07-20 18:00+00",
      endsAt: "2026-07-20 23:00+00",
    });

    // Manager A reads version 1 and commits an edit.
    const first = await sql`
      update shifts set headcount = 3, version = version + 1
       where id = ${shift.id} and version = ${shift.version}
      returning id
    `;
    expect(first).toHaveLength(1);

    // Manager B still holds version 1 and loses -- zero rows, which the service
    // layer turns into a 409 carrying current server state.
    const second = await sql`
      update shifts set headcount = 5, version = version + 1
       where id = ${shift.id} and version = ${shift.version}
      returning id
    `;
    expect(second).toHaveLength(0);

    const [current] = await sql<{ headcount: number; version: number }[]>`
      select headcount, version from shifts where id = ${shift.id}
    `;
    expect(current.headcount).toBe(3);
    expect(current.version).toBe(2);
  });
});

describe("multi-row rules under concurrency", () => {
  it("prevents two parallel assignments from jointly breaching the headcount ceiling", async () => {
    // Headcount counts sibling rows, so it cannot be an exclusion constraint --
    // and a naive count is subject to write skew, because each transaction sees
    // only its own uncommitted insert. The trigger takes a per-shift advisory
    // lock to close that. This test is what caught the omission.
    const location = await createLocation();
    const skill = await createSkill();

    const shift = await createShift({
      locationId: location.id,
      skillId: skill.id,
      startsAt: "2026-08-01 18:00+00",
      endsAt: "2026-08-01 23:00+00",
      headcount: 1,
    });

    const [alice, bob] = await Promise.all([
      createQualifiedStaff({ locationIds: [location.id], skillIds: [skill.id] }),
      createQualifiedStaff({ locationIds: [location.id], skillIds: [skill.id] }),
    ]);

    const fill = (staffId: string) =>
      sql.begin(async (tx) => {
        await tx`insert into assignments (shift_id, staff_id) values (${shift.id}, ${staffId})`;
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

    const results = await Promise.allSettled([fill(alice.id), fill(bob.id)]);

    const [row] = await sql<{ count: string }[]>`
      select count(*) from assignments where shift_id = ${shift.id} and status = 'active'
    `;

    expect(Number(row.count)).toBe(1);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("allows filling a shift up to its headcount, but not beyond", async () => {
    const location = await createLocation();
    const skill = await createSkill();
    const shift = await createShift({
      locationId: location.id,
      skillId: skill.id,
      startsAt: "2026-08-05 18:00+00",
      endsAt: "2026-08-05 23:00+00",
      headcount: 2,
    });

    const staff = await Promise.all([
      createQualifiedStaff({ locationIds: [location.id], skillIds: [skill.id] }),
      createQualifiedStaff({ locationIds: [location.id], skillIds: [skill.id] }),
      createQualifiedStaff({ locationIds: [location.id], skillIds: [skill.id] }),
    ]);

    await sql`insert into assignments (shift_id, staff_id) values (${shift.id}, ${staff[0].id})`;
    await sql`insert into assignments (shift_id, staff_id) values (${shift.id}, ${staff[1].id})`;

    await expect(
      sql`insert into assignments (shift_id, staff_id) values (${shift.id}, ${staff[2].id})`,
    ).rejects.toThrow(/fully staffed/i);
  });
});
