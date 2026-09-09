import { randomUUID } from "node:crypto";
import { sql } from "@/db/client";

/**
 * Test fixtures for the database-backed suites.
 *
 * Every fixture generates unique slugs and emails, so suites can run in
 * parallel without a shared truncate step racing between them. Tests assert on
 * ids they created, never on global table state.
 *
 * These run as the `postgres` superuser, which bypasses RLS. That is
 * deliberate: these suites test CONSTRAINTS and CONCURRENCY. Authorization is
 * exercised separately, through the Supabase client with a real user JWT.
 */

const short = () => randomUUID().slice(0, 8);

export interface LocationFixture {
  id: string;
  name: string;
  timezone: string;
}

export async function createLocation(
  timezone = "America/Los_Angeles",
): Promise<LocationFixture> {
  const suffix = short();
  const [row] = await sql<{ id: string; name: string; timezone: string }[]>`
    insert into locations (name, slug, timezone)
    values (${`Test Location ${suffix}`}, ${`test-loc-${suffix}`}, ${timezone})
    returning id, name, timezone
  `;
  return row;
}

export async function createSkill(name = "Bartender"): Promise<{ id: string; name: string }> {
  const suffix = short();
  const [row] = await sql<{ id: string; name: string }[]>`
    insert into skills (name, slug)
    values (${`${name} ${suffix}`}, ${`${name.toLowerCase()}-${suffix}`})
    returning id, name
  `;
  return row;
}

export async function createStaff(options: {
  homeTimezone?: string;
  role?: "admin" | "manager" | "staff";
  desiredWeeklyHours?: number | null;
  hourlyRate?: number;
} = {}): Promise<{ id: string; fullName: string }> {
  const suffix = short();
  const [row] = await sql<{ id: string; fullName: string }[]>`
    insert into profiles (full_name, email, role, home_timezone, desired_weekly_hours, hourly_rate)
    values (
      ${`Test Person ${suffix}`},
      ${`test-${suffix}@example.com`},
      ${options.role ?? "staff"},
      ${options.homeTimezone ?? "America/Los_Angeles"},
      ${options.desiredWeeklyHours ?? null},
      ${options.hourlyRate ?? 20}
    )
    returning id, full_name as "fullName"
  `;
  return row;
}

export async function certify(staffId: string, locationId: string, from = "2020-01-01") {
  await sql`
    insert into staff_certifications (staff_id, location_id, effective_from)
    values (${staffId}, ${locationId}, ${from}::date)
  `;
}

export async function grantSkill(staffId: string, skillId: string) {
  await sql`insert into staff_skills (staff_id, skill_id) values (${staffId}, ${skillId})`;
}

export async function createShift(options: {
  locationId: string;
  skillId: string;
  startsAt: string;
  endsAt: string;
  headcount?: number;
  isPublished?: boolean;
}): Promise<{ id: string; version: number; isPremium: boolean }> {
  const [row] = await sql<{ id: string; version: number; isPremium: boolean }[]>`
    insert into shifts (location_id, required_skill_id, starts_at, ends_at, headcount, is_published)
    values (
      ${options.locationId},
      ${options.skillId},
      ${options.startsAt}::timestamptz,
      ${options.endsAt}::timestamptz,
      ${options.headcount ?? 1},
      ${options.isPublished ?? false}
    )
    returning id, version, is_premium as "isPremium"
  `;
  return row;
}

/**
 * Insert an assignment.
 *
 * Only (shift_id, staff_id) is supplied: starts_at, ends_at and
 * rest_guard_ends_at are owned by the sync_assignment_times() trigger, which
 * copies them from the parent shift. They carry defaults precisely so callers
 * never name them.
 */
export async function assign(shiftId: string, staffId: string): Promise<{ id: string }> {
  const [row] = await sql<{ id: string }[]>`
    insert into assignments (shift_id, staff_id)
    values (${shiftId}, ${staffId})
    returning id
  `;
  return row;
}

/**
 * A fully-qualified staff member: certified, skilled, and (unless told
 * otherwise) available around the clock so tests isolate one rule at a time.
 */
export async function createQualifiedStaff(options: {
  locationIds: string[];
  skillIds: string[];
  homeTimezone?: string;
  desiredWeeklyHours?: number | null;
  alwaysAvailable?: boolean;
}) {
  const staff = await createStaff({
    homeTimezone: options.homeTimezone,
    desiredWeeklyHours: options.desiredWeeklyHours,
  });
  for (const locationId of options.locationIds) await certify(staff.id, locationId);
  for (const skillId of options.skillIds) await grantSkill(staff.id, skillId);
  if (options.alwaysAvailable !== false) {
    await setAlwaysAvailable(staff.id, options.homeTimezone);
  }
  return staff;
}

/**
 * Give a staff member round-the-clock availability.
 *
 * Most service-level tests are about a rule other than availability, and a
 * staff member with NO availability rules is treated as unavailable (never as
 * universally available), so tests must opt in explicitly.
 */
export async function setAlwaysAvailable(staffId: string, timezone = "America/Los_Angeles") {
  for (const isoWeekday of [1, 2, 3, 4, 5, 6, 7]) {
    await sql`
      insert into availability_rules (staff_id, iso_weekday, start_minute, end_minute, timezone)
      values (${staffId}, ${isoWeekday}, 0, 1440, ${timezone})
    `;
  }
}

/** Availability on one weekday only, as wall-clock minutes in `timezone`. */
export async function setAvailability(
  staffId: string,
  windows: { isoWeekday: number; startMinute: number; endMinute: number }[],
  timezone = "America/Los_Angeles",
) {
  for (const w of windows) {
    await sql`
      insert into availability_rules (staff_id, iso_weekday, start_minute, end_minute, timezone)
      values (${staffId}, ${w.isoWeekday}, ${w.startMinute}, ${w.endMinute}, ${timezone})
    `;
  }
}
