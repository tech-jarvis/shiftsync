import { createClient } from "@supabase/supabase-js";
import { DateTime } from "luxon";
import { sql } from "@/db/client";
import { requireEnv } from "@/lib/env";

/**
 * Seed "Coastal Eats": 4 locations across 2 timezones, with a schedule that
 * deliberately contains the situations the brief asks the system to handle.
 *
 * ---------------------------------------------------------------------------
 * A note on "existing conflicts"
 * ---------------------------------------------------------------------------
 * The brief asks for seed data with "some conflicts". Overlapping assignments
 * and sub-10-hour turnarounds CANNOT be seeded: the exclusion constraint makes
 * them unrepresentable, which is the point of putting them there. So the seeded
 * conflicts are the rule-level ones a manager actually has to reason about:
 *
 *   - someone projected into overtime (47.5h)
 *   - someone on a 6th consecutive day
 *   - an assignment stranded by a de-certification
 *   - a shift left short-staffed
 *   - pending swap and drop requests, one inside its expiry window
 *   - an overnight shift crossing midnight
 *   - a Pacific-based employee certified at an Eastern location, whose "9-5"
 *     availability does not mean what the Eastern schedule assumes
 *
 * Everything is anchored to the current week, so the demo is always "this week"
 * regardless of when it is run.
 */

const DEMO_PASSWORD = "ShiftSync!2026";

const LA = "America/Los_Angeles";
const NY = "America/New_York";

type Role = "admin" | "manager" | "staff";

interface SeedPerson {
  key: string;
  name: string;
  email: string;
  role: Role;
  timezone: string;
  skills: string[];
  locations: string[];
  desiredWeeklyHours?: number;
  hourlyRate: number;
  /** Availability as [isoWeekday, startHour, endHour] in the person's own zone. */
  availability?: [number, number, number][];
}

const WEEKDAYS_9_TO_5: [number, number, number][] = [1, 2, 3, 4, 5].map((d) => [d, 9, 17]);
const ALL_DAYS_EVENING: [number, number, number][] = [1, 2, 3, 4, 5, 6, 7].map((d) => [d, 15, 24]);
const ALL_DAYS_WIDE: [number, number, number][] = [1, 2, 3, 4, 5, 6, 7].map((d) => [d, 6, 24]);

const LOCATIONS = [
  { key: "santa-monica", name: "Coastal Eats Santa Monica", timezone: LA },
  { key: "venice", name: "Coastal Eats Venice", timezone: LA },
  { key: "portland", name: "Coastal Eats Portland ME", timezone: NY },
  { key: "providence", name: "Coastal Eats Providence", timezone: NY },
];

const SKILLS = [
  { key: "bartender", name: "Bartender" },
  { key: "line-cook", name: "Line Cook" },
  { key: "server", name: "Server" },
  { key: "host", name: "Host" },
];

const PEOPLE: SeedPerson[] = [
  {
    key: "admin",
    name: "Dana Reyes",
    email: "admin@coastaleats.test",
    role: "admin",
    timezone: LA,
    skills: [],
    locations: [],
    hourlyRate: 0,
  },
  {
    key: "mgr-pacific",
    name: "Marcus Hale",
    email: "marcus@coastaleats.test",
    role: "manager",
    timezone: LA,
    skills: [],
    locations: ["santa-monica", "venice"],
    hourlyRate: 0,
  },
  {
    key: "mgr-eastern",
    name: "Priya Raman",
    email: "priya@coastaleats.test",
    role: "manager",
    timezone: NY,
    skills: [],
    locations: ["portland", "providence"],
    hourlyRate: 0,
  },
  {
    key: "mgr-roaming",
    name: "Tomas Lindqvist",
    email: "tomas@coastaleats.test",
    role: "manager",
    timezone: LA,
    skills: [],
    locations: ["venice", "portland"],
    hourlyRate: 0,
  },

  // --- The Timezone Tangle: Pacific-based, certified on both coasts, "9-5" ---
  {
    key: "sofia",
    name: "Sofia Marchetti",
    email: "sofia@coastaleats.test",
    role: "staff",
    timezone: LA,
    skills: ["bartender", "server"],
    locations: ["santa-monica", "portland"],
    desiredWeeklyHours: 30,
    hourlyRate: 24,
    availability: WEEKDAYS_9_TO_5,
  },

  // --- Heads for overtime ---
  {
    key: "jamal",
    name: "Jamal Osei",
    email: "jamal@coastaleats.test",
    role: "staff",
    timezone: LA,
    skills: ["line-cook"],
    locations: ["santa-monica", "venice"],
    desiredWeeklyHours: 40,
    hourlyRate: 26,
    availability: ALL_DAYS_WIDE,
  },

  // --- Will be on a 6th consecutive day ---
  {
    key: "rina",
    name: "Rina Okafor",
    email: "rina@coastaleats.test",
    role: "staff",
    timezone: LA,
    skills: ["server", "host"],
    locations: ["venice"],
    desiredWeeklyHours: 25,
    hourlyRate: 21,
    availability: ALL_DAYS_EVENING,
  },

  // --- De-certified from Providence, but worked there historically ---
  {
    key: "eli",
    name: "Eli Bergstrom",
    email: "eli@coastaleats.test",
    role: "staff",
    timezone: NY,
    skills: ["bartender", "server"],
    locations: ["portland"],
    desiredWeeklyHours: 20,
    hourlyRate: 23,
    availability: ALL_DAYS_EVENING,
  },

  { key: "noor", name: "Noor Haddad", email: "noor@coastaleats.test", role: "staff",
    timezone: LA, skills: ["bartender"], locations: ["santa-monica", "venice"],
    desiredWeeklyHours: 32, hourlyRate: 25, availability: ALL_DAYS_EVENING },
  { key: "kenji", name: "Kenji Watanabe", email: "kenji@coastaleats.test", role: "staff",
    timezone: LA, skills: ["line-cook", "server"], locations: ["santa-monica"],
    desiredWeeklyHours: 38, hourlyRate: 24, availability: ALL_DAYS_WIDE },
  { key: "aisha", name: "Aisha Bello", email: "aisha@coastaleats.test", role: "staff",
    timezone: LA, skills: ["server", "host"], locations: ["venice", "santa-monica"],
    desiredWeeklyHours: 15, hourlyRate: 20, availability: ALL_DAYS_EVENING },
  { key: "diego", name: "Diego Salazar", email: "diego@coastaleats.test", role: "staff",
    timezone: LA, skills: ["line-cook"], locations: ["venice"],
    desiredWeeklyHours: 40, hourlyRate: 26, availability: ALL_DAYS_WIDE },
  { key: "hannah", name: "Hannah Pryce", email: "hannah@coastaleats.test", role: "staff",
    timezone: LA, skills: ["host"], locations: ["santa-monica", "venice"],
    desiredWeeklyHours: 12, hourlyRate: 19, availability: ALL_DAYS_EVENING },
  { key: "grace", name: "Grace Amoah", email: "grace@coastaleats.test", role: "staff",
    timezone: NY, skills: ["bartender", "host"], locations: ["portland", "providence"],
    desiredWeeklyHours: 30, hourlyRate: 24, availability: ALL_DAYS_EVENING },
  { key: "luca", name: "Luca Ferrari", email: "luca@coastaleats.test", role: "staff",
    timezone: NY, skills: ["line-cook"], locations: ["portland", "providence"],
    desiredWeeklyHours: 35, hourlyRate: 25, availability: ALL_DAYS_WIDE },
  { key: "maya", name: "Maya Thompson", email: "maya@coastaleats.test", role: "staff",
    timezone: NY, skills: ["server"], locations: ["providence"],
    desiredWeeklyHours: 28, hourlyRate: 21, availability: ALL_DAYS_EVENING },
  { key: "owen", name: "Owen Whitfield", email: "owen@coastaleats.test", role: "staff",
    timezone: NY, skills: ["server", "bartender"], locations: ["providence", "portland"],
    desiredWeeklyHours: 24, hourlyRate: 22, availability: ALL_DAYS_EVENING },
  { key: "zara", name: "Zara Nkemdirim", email: "zara@coastaleats.test", role: "staff",
    timezone: NY, skills: ["host", "server"], locations: ["portland"],
    desiredWeeklyHours: 18, hourlyRate: 20, availability: ALL_DAYS_EVENING },
  { key: "felix", name: "Felix Dubois", email: "felix@coastaleats.test", role: "staff",
    timezone: LA, skills: ["bartender", "line-cook"], locations: ["santa-monica"],
    desiredWeeklyHours: 36, hourlyRate: 27, availability: ALL_DAYS_WIDE },
  { key: "ines", name: "Ines Carvalho", email: "ines@coastaleats.test", role: "staff",
    timezone: LA, skills: ["server"], locations: ["venice"],
    desiredWeeklyHours: 20, hourlyRate: 20, availability: ALL_DAYS_EVENING },
];

// ---------------------------------------------------------------------------

const ids = {
  locations: new Map<string, string>(),
  skills: new Map<string, string>(),
  people: new Map<string, string>(),
};

/** Monday 00:00 of the current week, in a given zone. */
function weekStart(zone: string, weekOffset = 0): DateTime {
  return DateTime.now().setZone(zone).startOf("day").minus({
    days: DateTime.now().setZone(zone).weekday - 1,
  }).plus({ weeks: weekOffset });
}

/** An instant from (week offset, weekday, local hour) in a location's zone. */
function slot(zone: string, weekOffset: number, isoWeekday: number, hour: number): Date {
  return weekStart(zone, weekOffset)
    .plus({ days: isoWeekday - 1 })
    .set({ hour: Math.floor(hour), minute: Math.round((hour % 1) * 60) })
    .toJSDate();
}

async function wipe() {
  // Order matters only for readability; every FK cascades.
  await sql`truncate
    audit_log, notifications, email_outbox, rule_overrides, swap_requests,
    assignments, shifts, availability_exceptions, availability_rules,
    staff_certifications, staff_skills, manager_locations, profiles,
    skills, locations
    restart identity cascade`;
}

async function seedReferenceData() {
  for (const location of LOCATIONS) {
    const [row] = await sql<{ id: string }[]>`
      insert into locations (name, slug, timezone)
      values (${location.name}, ${location.key}, ${location.timezone})
      returning id
    `;
    ids.locations.set(location.key, row.id);
  }

  for (const skill of SKILLS) {
    const [row] = await sql<{ id: string }[]>`
      insert into skills (name, slug) values (${skill.name}, ${skill.key}) returning id
    `;
    ids.skills.set(skill.key, row.id);
  }
}

async function seedPeople() {
  const admin = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  // IDEMPOTENCY: wipe() truncates `profiles`, but auth.users lives in the auth
  // schema and survives. So on a second `pnpm seed` without a db reset, every
  // createUser would fail with "already been registered" -- and if that error
  // is merely swallowed, every profile is written with a NULL auth_user_id and
  // nobody can log in at all. Existing auth users are therefore looked up and
  // REUSED, with their password reset to the demo one.
  const existingByEmail = new Map<string, string>();
  const { data: existing, error: listError } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 200,
  });
  if (listError) throw listError;
  for (const user of existing.users) {
    if (user.email) existingByEmail.set(user.email, user.id);
  }

  for (const person of PEOPLE) {
    // A real login for every seeded person, so the evaluator can sign in as any
    // role and switch between them freely.
    let authUserId = existingByEmail.get(person.email) ?? null;

    if (authUserId) {
      const { error } = await admin.auth.admin.updateUserById(authUserId, {
        password: DEMO_PASSWORD,
        email_confirm: true,
      });
      if (error) throw error;
    } else {
      const { data, error } = await admin.auth.admin.createUser({
        email: person.email,
        password: DEMO_PASSWORD,
        email_confirm: true,
      });
      if (error) throw error;
      authUserId = data.user?.id ?? null;
    }

    if (!authUserId) {
      throw new Error(`Could not resolve an auth user for ${person.email}`);
    }

    const [row] = await sql<{ id: string }[]>`
      insert into profiles (
        auth_user_id, full_name, email, role, home_timezone,
        desired_weekly_hours, hourly_rate, email_simulation_enabled
      )
      values (
        ${authUserId}, ${person.name}, ${person.email}, ${person.role},
        ${person.timezone}, ${person.desiredWeeklyHours ?? null}, ${person.hourlyRate},
        ${person.role !== "staff"}
      )
      returning id
    `;
    ids.people.set(person.key, row.id);

    for (const skillKey of person.skills) {
      await sql`insert into staff_skills (staff_id, skill_id)
                values (${row.id}, ${ids.skills.get(skillKey)!})`;
    }

    if (person.role === "manager") {
      for (const locationKey of person.locations) {
        await sql`insert into manager_locations (manager_id, location_id)
                  values (${row.id}, ${ids.locations.get(locationKey)!})`;
      }
    } else {
      for (const locationKey of person.locations) {
        await sql`insert into staff_certifications (staff_id, location_id, effective_from)
                  values (${row.id}, ${ids.locations.get(locationKey)!}, '2024-01-01'::date)`;
      }
    }

    for (const [isoWeekday, startHour, endHour] of person.availability ?? []) {
      await sql`
        insert into availability_rules (staff_id, iso_weekday, start_minute, end_minute, timezone)
        values (${row.id}, ${isoWeekday}, ${startHour * 60}, ${endHour * 60}, ${person.timezone})
      `;
    }
  }
}

/**
 * Eli worked at Providence until the certification was closed last month. The
 * historical assignment stays valid and explicable -- that is the documented
 * de-certification decision, made visible in the data.
 */
async function seedDecertification() {
  const eli = ids.people.get("eli")!;
  const providence = ids.locations.get("providence")!;
  const endedOn = DateTime.now().minus({ days: 30 }).toFormat("yyyy-MM-dd");

  await sql`
    insert into staff_certifications (staff_id, location_id, effective_from, effective_to)
    values (${eli}, ${providence}, '2024-01-01'::date, ${endedOn}::date)
  `;

  const [shift] = await sql<{ id: string }[]>`
    insert into shifts (location_id, required_skill_id, starts_at, ends_at, headcount, is_published)
    values (${providence}, ${ids.skills.get("bartender")!},
            ${slot(NY, -6, 5, 17)}, ${slot(NY, -6, 5, 23)}, 1, true)
    returning id
  `;
  await sql`insert into assignments (shift_id, staff_id) values (${shift.id}, ${eli})`;
}

interface ShiftPlan {
  location: string;
  skill: string;
  weekOffset: number;
  isoWeekday: number;
  startHour: number;
  endHour: number;
  headcount?: number;
  published?: boolean;
  staff?: string[];
}

async function createShifts(plans: ShiftPlan[]) {
  for (const plan of plans) {
    const zone = LOCATIONS.find((l) => l.key === plan.location)!.timezone;
    const startsAt = slot(zone, plan.weekOffset, plan.isoWeekday, plan.startHour);
    const endsAt =
      plan.endHour > 24
        ? slot(zone, plan.weekOffset, plan.isoWeekday + 1, plan.endHour - 24)
        : slot(zone, plan.weekOffset, plan.isoWeekday, plan.endHour);

    const [shift] = await sql<{ id: string }[]>`
      insert into shifts (location_id, required_skill_id, starts_at, ends_at, headcount, is_published, published_at)
      values (
        ${ids.locations.get(plan.location)!}, ${ids.skills.get(plan.skill)!},
        ${startsAt}, ${endsAt}, ${plan.headcount ?? 1},
        ${plan.published ?? true}, ${plan.published === false ? null : new Date()}
      )
      returning id
    `;

    for (const staffKey of plan.staff ?? []) {
      await sql`insert into assignments (shift_id, staff_id)
                values (${shift.id}, ${ids.people.get(staffKey)!})`;
    }
  }
}

async function seedSchedule() {
  const plans: ShiftPlan[] = [];

  // --- Jamal into overtime: five 9.5h days = 47.5h this week ------------------
  for (const day of [1, 2, 3, 4, 5]) {
    plans.push({
      location: "santa-monica", skill: "line-cook", weekOffset: 0,
      isoWeekday: day, startHour: 10, endHour: 19.5, staff: ["jamal"],
    });
  }

  // --- Rina onto a 6th consecutive day ---------------------------------------
  for (const day of [1, 2, 3, 4, 5, 6]) {
    plans.push({
      location: "venice", skill: "server", weekOffset: 0,
      isoWeekday: day, startHour: 17, endHour: 22, staff: ["rina"],
    });
  }

  // --- An overnight shift crossing midnight ----------------------------------
  plans.push({
    location: "venice", skill: "bartender", weekOffset: 0,
    isoWeekday: 5, startHour: 23, endHour: 27, staff: ["noor"],
  });

  // --- Premium Friday/Saturday evenings, unevenly distributed on purpose -----
  // Noor takes most of them; Aisha takes none. This is the Fairness Complaint.
  for (const weekOffset of [-3, -2, -1]) {
    for (const day of [5, 6]) {
      plans.push({
        location: "santa-monica", skill: "bartender", weekOffset,
        isoWeekday: day, startHour: 18, endHour: 23, staff: ["noor"],
      });
      plans.push({
        location: "venice", skill: "server", weekOffset,
        isoWeekday: day, startHour: 18, endHour: 23, staff: ["rina"],
      });
      plans.push({
        location: "santa-monica", skill: "host", weekOffset,
        isoWeekday: day, startHour: 18, endHour: 23, staff: ["hannah"],
      });
    }
    // Aisha only ever gets weekday lunches.
    for (const day of [2, 3]) {
      plans.push({
        location: "venice", skill: "server", weekOffset,
        isoWeekday: day, startHour: 16, endHour: 20, staff: ["aisha"],
      });
    }
  }

  // --- A deliberately short-staffed premium shift (needs 3, has 1) -----------
  plans.push({
    location: "santa-monica", skill: "server", weekOffset: 0,
    isoWeekday: 6, startHour: 18, endHour: 23, headcount: 3, staff: ["kenji"],
  });

  // --- Eastern locations, this week ------------------------------------------
  for (const day of [1, 2, 3, 4, 5]) {
    plans.push({ location: "portland", skill: "line-cook", weekOffset: 0,
      isoWeekday: day, startHour: 16, endHour: 22, staff: ["luca"] });
    plans.push({ location: "providence", skill: "server", weekOffset: 0,
      isoWeekday: day, startHour: 17, endHour: 22, staff: ["maya"] });
  }
  plans.push({ location: "portland", skill: "bartender", weekOffset: 0,
    isoWeekday: 6, startHour: 18, endHour: 24, staff: ["grace"] });
  plans.push({ location: "portland", skill: "host", weekOffset: 0,
    isoWeekday: 5, startHour: 17, endHour: 22, staff: ["zara"] });
  plans.push({ location: "providence", skill: "bartender", weekOffset: 0,
    isoWeekday: 5, startHour: 17, endHour: 23, staff: ["owen"] });

  // --- An UNPUBLISHED draft for next week, with gaps to fill -----------------
  for (const day of [1, 2, 3, 4, 5]) {
    plans.push({ location: "santa-monica", skill: "line-cook", weekOffset: 1,
      isoWeekday: day, startHour: 10, endHour: 18, published: false,
      staff: day <= 3 ? ["felix"] : [] });
    plans.push({ location: "venice", skill: "server", weekOffset: 1,
      isoWeekday: day, startHour: 17, endHour: 22, published: false,
      staff: day <= 2 ? ["ines"] : [] });
  }
  // An unfilled Eastern shift Sofia is certified for -- the Timezone Tangle
  // demo: her Pacific "9-5" cannot cover an Eastern morning.
  plans.push({ location: "portland", skill: "server", weekOffset: 1,
    isoWeekday: 3, startHour: 9, endHour: 17, published: false });

  await createShifts(plans);
}

/** Two pending swaps and a drop request inside its 24h expiry window. */
async function seedRequests() {
  const [rinaShift] = await sql<{ assignmentId: string; startsAt: Date }[]>`
    select a.id as "assignmentId", a.starts_at as "startsAt"
      from assignments a
      join shifts s on s.id = a.shift_id
     where a.staff_id = ${ids.people.get("rina")!}
       and a.starts_at > now()
     order by a.starts_at
     limit 1
  `;

  if (rinaShift) {
    await sql`
      insert into swap_requests (kind, state, requester_id, requester_assignment_id, target_staff_id)
      values ('swap', 'pending_target', ${ids.people.get("rina")!},
              ${rinaShift.assignmentId}, ${ids.people.get("aisha")!})
    `;
  }

  const [noorShift] = await sql<{ assignmentId: string; startsAt: Date }[]>`
    select a.id as "assignmentId", a.starts_at as "startsAt"
      from assignments a
     where a.staff_id = ${ids.people.get("noor")!}
       and a.starts_at > now()
     order by a.starts_at
     limit 1
  `;

  if (noorShift) {
    await sql`
      insert into swap_requests (kind, state, requester_id, requester_assignment_id, expires_at)
      values ('drop', 'open', ${ids.people.get("noor")!}, ${noorShift.assignmentId},
              ${new Date(noorShift.startsAt.getTime() - 24 * 3_600_000)})
    `;
  }

  const [lucaShift] = await sql<{ assignmentId: string }[]>`
    select a.id as "assignmentId" from assignments a
     where a.staff_id = ${ids.people.get("luca")!} and a.starts_at > now()
     order by a.starts_at limit 1
  `;

  if (lucaShift) {
    await sql`
      insert into swap_requests (kind, state, requester_id, requester_assignment_id,
                                 target_staff_id, claimed_by, claimed_at)
      values ('swap', 'pending_manager', ${ids.people.get("luca")!}, ${lucaShift.assignmentId},
              ${ids.people.get("grace")!}, ${ids.people.get("grace")!}, now())
    `;
  }
}

/** One-off availability exceptions, including a call-out. */
async function seedAvailabilityExceptions() {
  const tomorrow = DateTime.now().setZone(LA).plus({ days: 1 }).toFormat("yyyy-MM-dd");
  await sql`
    insert into availability_exceptions (staff_id, on_date, is_available, timezone, reason)
    values (${ids.people.get("kenji")!}, ${tomorrow}::date, false, ${LA}, 'Family commitment')
  `;

  const saturday = DateTime.now().setZone(LA).plus({ days: 5 }).toFormat("yyyy-MM-dd");
  await sql`
    insert into availability_exceptions
      (staff_id, on_date, is_available, start_minute, end_minute, timezone, reason)
    values (${ids.people.get("aisha")!}, ${saturday}::date, true, ${18 * 60}, ${23 * 60},
            ${LA}, 'Available for the Saturday dinner rush')
  `;
}

async function main() {
  console.log("Seeding Coastal Eats...");

  await wipe();
  await seedReferenceData();
  console.log(`  ${LOCATIONS.length} locations, ${SKILLS.length} skills`);

  await seedPeople();
  console.log(`  ${PEOPLE.length} people with logins`);

  await seedDecertification();
  await seedSchedule();
  await seedRequests();
  await seedAvailabilityExceptions();

  const [counts] = await sql<
    { shifts: string; assignments: string; requests: string }[]
  >`
    select (select count(*) from shifts)        as shifts,
           (select count(*) from assignments)   as assignments,
           (select count(*) from swap_requests) as requests
  `;

  console.log(`  ${counts.shifts} shifts, ${counts.assignments} assignments, ${counts.requests} requests`);
  console.log(`\nEvery account uses the password: ${DEMO_PASSWORD}`);
  console.log("  admin@coastaleats.test    Admin, all locations");
  console.log("  marcus@coastaleats.test   Manager, Santa Monica + Venice");
  console.log("  priya@coastaleats.test    Manager, Portland + Providence");
  console.log("  sofia@coastaleats.test    Staff, Pacific-based, certified on both coasts");
  console.log("  jamal@coastaleats.test    Staff, projected into overtime this week");
  console.log("  rina@coastaleats.test     Staff, on a 6th consecutive day");

  await sql.end();
}

main().catch(async (error) => {
  console.error(error);
  await sql.end();
  process.exit(1);
});
