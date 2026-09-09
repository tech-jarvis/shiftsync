import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  checkConflicts,
  checkConsecutiveDays,
  checkDailyHours,
  checkEditCutoff,
  checkHeadcount,
  checkWeeklyHours,
  checkCertification,
  checkSkill,
  projectHours,
  validateAssignment,
  type ExistingAssignment,
  type ShiftSnapshot,
  type StaffSnapshot,
  type ValidationInput,
} from "@/rules";

const LA = "America/Los_Angeles";
const NY = "America/New_York";

const t = (iso: string, zone = LA) => DateTime.fromISO(iso, { zone }).toMillis();

const SKILL_BARTENDER = "skill-bartender";
const LOCATION_PACIFIC = "loc-pacific";
const LOCATION_EASTERN = "loc-eastern";

/** Available 24/7 by default, so each test isolates the one rule under test. */
const ALWAYS_AVAILABLE = [1, 2, 3, 4, 5, 6, 7].map((isoWeekday) => ({
  isoWeekday,
  startMinute: 0,
  endMinute: 1440,
  timezone: LA,
}));

function staff(over: Partial<StaffSnapshot> = {}): StaffSnapshot {
  return {
    id: "staff-1",
    fullName: "Sarah Chen",
    homeTimezone: LA,
    skillIds: [SKILL_BARTENDER],
    certifications: [
      { locationId: LOCATION_PACIFIC, effectiveFrom: "2020-01-01", effectiveTo: null },
      { locationId: LOCATION_EASTERN, effectiveFrom: "2020-01-01", effectiveTo: null },
    ],
    availabilityRules: ALWAYS_AVAILABLE,
    availabilityExceptions: [],
    desiredWeeklyHours: null,
    ...over,
  };
}

function shift(over: Partial<ShiftSnapshot> = {}): ShiftSnapshot {
  return {
    id: "shift-1",
    locationId: LOCATION_PACIFIC,
    locationName: "Coastal Eats Santa Monica",
    locationTimezone: LA,
    requiredSkillId: SKILL_BARTENDER,
    requiredSkillName: "Bartender",
    startsAt: t("2026-06-15T09:00"),
    endsAt: t("2026-06-15T17:00"),
    headcount: 2,
    filledCount: 0,
    isPublished: false,
    ...over,
  };
}

function existing(over: Partial<ExistingAssignment> = {}): ExistingAssignment {
  return {
    id: "assignment-x",
    shiftId: "shift-x",
    startsAt: t("2026-06-14T09:00"),
    endsAt: t("2026-06-14T17:00"),
    locationName: "Coastal Eats Venice",
    locationTimezone: LA,
    ...over,
  };
}

const input = (over: Partial<ValidationInput> = {}): ValidationInput => ({
  staff: staff(),
  shift: shift(),
  existing: [],
  now: t("2026-06-01T00:00"),
  ...over,
});

// ---------------------------------------------------------------------------

describe("double-booking and minimum rest", () => {
  it("blocks an overlapping shift and names the conflicting location", () => {
    const [violation] = checkConflicts(
      input({
        existing: [
          existing({ startsAt: t("2026-06-15T12:00"), endsAt: t("2026-06-15T20:00") }),
        ],
      }),
    );

    expect(violation.code).toBe("DOUBLE_BOOKED");
    expect(violation.severity).toBe("block");
    expect(violation.message).toContain("Coastal Eats Venice");
    expect(violation.message).toContain("Sarah Chen");
  });

  it("blocks a turnaround shorter than 10 hours and states the actual gap", () => {
    // Previous shift ends 2026-06-15 03:00; candidate starts 09:00 -> 6h rest.
    const [violation] = checkConflicts(
      input({
        existing: [
          existing({ startsAt: t("2026-06-14T19:00"), endsAt: t("2026-06-15T03:00") }),
        ],
      }),
    );

    expect(violation.code).toBe("INSUFFICIENT_REST");
    expect(violation.severity).toBe("block");
    expect(violation.message).toContain("6h");
    expect(violation.meta).toMatchObject({ gapHours: 6, requiredHours: 10 });
  });

  it("allows exactly 10 hours of rest, matching the database constraint exactly", () => {
    // Ends 23:00 the night before; candidate starts 09:00 -> precisely 10h.
    const violations = checkConflicts(
      input({
        existing: [
          existing({ startsAt: t("2026-06-14T15:00"), endsAt: t("2026-06-14T23:00") }),
        ],
      }),
    );
    expect(violations).toEqual([]);
  });

  it("blocks at 9h59m, so the boundary is precise rather than approximate", () => {
    const violations = checkConflicts(
      input({
        existing: [
          existing({ startsAt: t("2026-06-14T15:01"), endsAt: t("2026-06-14T23:01") }),
        ],
      }),
    );
    expect(violations[0]?.code).toBe("INSUFFICIENT_REST");
  });

  it("checks rest in both directions, not just backwards", () => {
    // Candidate ends 17:00; the NEXT shift starts 22:00 -> only 5h rest after.
    const [violation] = checkConflicts(
      input({
        existing: [
          existing({ startsAt: t("2026-06-15T22:00"), endsAt: t("2026-06-16T02:00") }),
        ],
      }),
    );
    expect(violation.code).toBe("INSUFFICIENT_REST");
    expect(violation.message).toContain("before");
  });

  it("ignores the shift being validated against itself", () => {
    const violations = checkConflicts(
      input({
        existing: [
          existing({
            shiftId: "shift-1",
            startsAt: t("2026-06-15T09:00"),
            endsAt: t("2026-06-15T17:00"),
          }),
        ],
      }),
    );
    expect(violations).toEqual([]);
  });

  it("catches a cross-timezone overlap that looks fine in local wall-clock terms", () => {
    // 09:00-17:00 Eastern overlaps 09:00-17:00 Pacific in real time, even though
    // both read as "9 to 5" on their own clocks.
    const [violation] = checkConflicts(
      input({
        shift: shift({
          locationId: LOCATION_EASTERN,
          locationName: "Coastal Eats Portland ME",
          locationTimezone: NY,
          startsAt: t("2026-06-15T09:00", NY),
          endsAt: t("2026-06-15T17:00", NY),
        }),
        existing: [
          existing({ startsAt: t("2026-06-15T09:00", LA), endsAt: t("2026-06-15T17:00", LA) }),
        ],
      }),
    );
    expect(violation.code).toBe("DOUBLE_BOOKED");
  });
});

describe("skill and certification", () => {
  it("blocks when the staff member lacks the required skill", () => {
    const [violation] = checkSkill(input({ staff: staff({ skillIds: ["skill-host"] }) }));
    expect(violation.code).toBe("MISSING_SKILL");
    expect(violation.message).toContain("Bartender");
  });

  it("blocks at a location the staff member was never certified for", () => {
    const [violation] = checkCertification(
      input({ staff: staff({ certifications: [] }) }),
    );
    expect(violation.code).toBe("NOT_CERTIFIED");
    expect(violation.message).toContain("not certified");
  });

  it("distinguishes a lapsed certification from never having held one", () => {
    const [violation] = checkCertification(
      input({
        staff: staff({
          certifications: [
            { locationId: LOCATION_PACIFIC, effectiveFrom: "2020-01-01", effectiveTo: "2026-01-31" },
          ],
        }),
      }),
    );
    expect(violation.code).toBe("NOT_CERTIFIED");
    expect(violation.message).toContain("ended on 2026-01-31");
  });

  it("judges certification as-of the shift date, so historical shifts stay valid", () => {
    // De-certified in Feb 2026; a shift in Jan 2026 was legitimate at the time.
    const violations = checkCertification(
      input({
        staff: staff({
          certifications: [
            { locationId: LOCATION_PACIFIC, effectiveFrom: "2020-01-01", effectiveTo: "2026-02-28" },
          ],
        }),
        shift: shift({
          startsAt: t("2026-01-15T09:00"),
          endsAt: t("2026-01-15T17:00"),
        }),
      }),
    );
    expect(violations).toEqual([]);
  });
});

describe("daily hours", () => {
  it("warns above 8 hours in a day", () => {
    const [violation] = checkDailyHours(
      input({
        shift: shift({ startsAt: t("2026-06-15T09:00"), endsAt: t("2026-06-15T19:00") }),
      }),
    );
    expect(violation.code).toBe("DAILY_HOURS_WARN");
    expect(violation.severity).toBe("warn");
    expect(violation.message).toContain("10h");
  });

  it("hard-blocks above 12 hours in a day", () => {
    const [violation] = checkDailyHours(
      input({
        shift: shift({ startsAt: t("2026-06-15T06:00"), endsAt: t("2026-06-15T19:00") }),
      }),
    );
    expect(violation.code).toBe("DAILY_HOURS_BLOCK");
    expect(violation.severity).toBe("block");
  });

  it("says nothing at exactly 8 hours", () => {
    expect(checkDailyHours(input())).toEqual([]);
  });

  it("attributes an overnight shift wholly to its start date", () => {
    // 23:00 -> 03:00 is one 4h shift belonging to the 15th, not 1h on the 15th
    // and 3h on the 16th.
    const projection = projectHours(
      input({
        shift: shift({ startsAt: t("2026-06-15T23:00"), endsAt: t("2026-06-16T03:00") }),
      }),
    );
    expect(projection.dayKey).toBe("2026-06-15");
    expect(projection.dailyHoursAfter).toBe(4);
  });

  it("sums multiple shifts landing on the same local day", () => {
    const [violation] = checkDailyHours(
      input({
        shift: shift({ startsAt: t("2026-06-15T18:00"), endsAt: t("2026-06-15T23:00") }),
        existing: [
          existing({ startsAt: t("2026-06-15T06:00"), endsAt: t("2026-06-15T11:00") }),
        ],
      }),
    );
    expect(violation.code).toBe("DAILY_HOURS_WARN");
    expect(violation.meta).toMatchObject({ dailyHoursAfter: 10 });
  });
});

describe("weekly hours (brief scenario 2 -- the Overtime Trap)", () => {
  /** Five 8h days, Mon-Fri of the week containing 2026-06-15 (a Monday). */
  const fortyHourWeek = (): ExistingAssignment[] =>
    [15, 16, 17, 18, 19].map((day, i) => ({
      id: `a-${i}`,
      shiftId: `s-${i}`,
      startsAt: t(`2026-06-${day}T09:00`),
      endsAt: t(`2026-06-${day}T17:00`),
      locationName: "Coastal Eats Venice",
      locationTimezone: LA,
    }));

  it("warns as the week approaches 40 hours", () => {
    // Four 8h days already = 32h; adding 4h reaches 36h.
    const [violation] = checkWeeklyHours(
      input({
        shift: shift({ startsAt: t("2026-06-20T09:00"), endsAt: t("2026-06-20T13:00") }),
        existing: fortyHourWeek().slice(0, 4),
      }),
    );
    expect(violation.code).toBe("WEEKLY_HOURS_WARN");
    expect(violation.meta).toMatchObject({ weeklyHoursAfter: 36 });
  });

  it("surfaces overtime with the exact hours, rather than silently allowing it", () => {
    // The Overtime Trap: 40h already booked, and this 12h Saturday takes them
    // to 52 -- the number in the brief.
    const [violation] = checkWeeklyHours(
      input({
        shift: shift({ startsAt: t("2026-06-20T09:00"), endsAt: t("2026-06-20T21:00") }),
        existing: fortyHourWeek(),
      }),
    );

    expect(violation.code).toBe("WEEKLY_OVERTIME");
    expect(violation.message).toContain("52h");
    expect(violation.meta).toMatchObject({ weeklyHoursAfter: 52, overtimeHours: 12 });
  });

  it("does not block overtime -- it is a cost decision for a manager to take knowingly", () => {
    const violations = checkWeeklyHours(
      input({
        shift: shift({ startsAt: t("2026-06-20T09:00"), endsAt: t("2026-06-20T21:00") }),
        existing: fortyHourWeek(),
      }),
    );
    expect(violations.every((v) => v.severity === "warn")).toBe(true);
  });

  it("does not count hours from the previous week", () => {
    // Same five 8h days, but a week earlier -- must not bleed into this week.
    const previousWeek = fortyHourWeek().map((a, i) => ({
      ...a,
      id: `prev-${i}`,
      startsAt: a.startsAt - 7 * 24 * 3_600_000,
      endsAt: a.endsAt - 7 * 24 * 3_600_000,
    }));

    const projection = projectHours(
      input({
        shift: shift({ startsAt: t("2026-06-20T09:00"), endsAt: t("2026-06-20T13:00") }),
        existing: previousWeek,
      }),
    );
    expect(projection.weeklyHoursBefore).toBe(0);
    expect(projection.weeklyHoursAfter).toBe(4);
  });

  it("reports the delta against stated desired hours", () => {
    const projection = projectHours(
      input({
        staff: staff({ desiredWeeklyHours: 20 }),
        shift: shift({ startsAt: t("2026-06-20T09:00"), endsAt: t("2026-06-20T17:00") }),
        existing: fortyHourWeek().slice(0, 2),
      }),
    );
    // 16h existing + 8h candidate = 24h against a desire of 20h.
    expect(projection.desiredHoursDelta).toBe(4);
  });
});

describe("consecutive days", () => {
  const daysWorked = (days: number[]): ExistingAssignment[] =>
    days.map((day, i) => ({
      id: `c-${i}`,
      shiftId: `cs-${i}`,
      startsAt: t(`2026-06-${String(day).padStart(2, "0")}T09:00`),
      endsAt: t(`2026-06-${String(day).padStart(2, "0")}T14:00`),
      locationName: "Coastal Eats Venice",
      locationTimezone: LA,
    }));

  it("warns on the 6th consecutive day", () => {
    const [violation] = checkConsecutiveDays(
      input({
        shift: shift({ startsAt: t("2026-06-15T09:00"), endsAt: t("2026-06-15T14:00") }),
        existing: daysWorked([10, 11, 12, 13, 14]),
      }),
    );
    expect(violation.code).toBe("CONSECUTIVE_DAYS_WARN");
    expect(violation.severity).toBe("warn");
    expect(violation.meta).toMatchObject({ length: 6 });
  });

  it("requires a documented override on the 7th", () => {
    const [violation] = checkConsecutiveDays(
      input({
        shift: shift({ startsAt: t("2026-06-16T09:00"), endsAt: t("2026-06-16T14:00") }),
        existing: daysWorked([10, 11, 12, 13, 14, 15]),
      }),
    );
    expect(violation.code).toBe("CONSECUTIVE_DAYS_OVERRIDE");
    expect(violation.severity).toBe("override_required");
    expect(violation.message).toContain("documented reason");
  });

  it("counts a 1-hour shift as a worked day, but reports the run's real hours", () => {
    // Five long days plus one 1h day: still a 6-day run, and the message carries
    // the hours so a manager can judge how severe this particular run is.
    const shortDay: ExistingAssignment = {
      id: "short",
      shiftId: "short-s",
      startsAt: t("2026-06-14T09:00"),
      endsAt: t("2026-06-14T10:00"),
      locationName: "Coastal Eats Venice",
      locationTimezone: LA,
    };

    const [violation] = checkConsecutiveDays(
      input({
        shift: shift({ startsAt: t("2026-06-15T09:00"), endsAt: t("2026-06-15T14:00") }),
        existing: [...daysWorked([10, 11, 12, 13]), shortDay],
      }),
    );

    expect(violation.meta).toMatchObject({ length: 6 });
    // 4 x 5h + 1h + 5h candidate = 26h
    expect(violation.meta).toMatchObject({ totalHours: 26 });
  });

  it("breaks the run on a rest day", () => {
    // Worked 10-12, rested 13, worked 14 -- the candidate on the 15th makes a
    // run of 3, not 6.
    const violations = checkConsecutiveDays(
      input({
        shift: shift({ startsAt: t("2026-06-15T09:00"), endsAt: t("2026-06-15T14:00") }),
        existing: daysWorked([10, 11, 12, 14]),
      }),
    );
    expect(violations).toEqual([]);
  });

  it("counts a run that spans the week boundary", () => {
    // Sun 14 June ends one ISO week and Mon 15 starts the next. Six prior days
    // (Wed 10 - Mon 15) plus the candidate on Tue 16 is a 7-day run straddling
    // that boundary. Resetting the count at the week edge would report 2 days
    // and wave it through; a run through the boundary is exactly as tiring.
    const [violation] = checkConsecutiveDays(
      input({
        shift: shift({ startsAt: t("2026-06-16T09:00"), endsAt: t("2026-06-16T14:00") }),
        existing: daysWorked([10, 11, 12, 13, 14, 15]),
      }),
    );
    expect(violation.code).toBe("CONSECUTIVE_DAYS_OVERRIDE");
    expect(violation.meta).toMatchObject({ length: 7 });
  });
});

describe("shift capacity and the edit cutoff", () => {
  it("blocks assigning to a shift that is already full", () => {
    const [violation] = checkHeadcount(
      input({ shift: shift({ headcount: 2, filledCount: 2 }) }),
    );
    expect(violation.code).toBe("SHIFT_FULL");
  });

  it("allows assigning while a slot remains", () => {
    expect(checkHeadcount(input({ shift: shift({ headcount: 2, filledCount: 1 }) }))).toEqual([]);
  });

  it("locks a published shift inside the 48h cutoff", () => {
    const [violation] = checkEditCutoff(
      input({
        shift: shift({ isPublished: true, startsAt: t("2026-06-15T09:00") }),
        now: t("2026-06-14T09:00"), // 24h before
      }),
    );
    expect(violation.code).toBe("SHIFT_LOCKED");
    expect(violation.message).toContain("swap or coverage");
  });

  it("leaves a published shift editable outside the cutoff", () => {
    expect(
      checkEditCutoff(
        input({
          shift: shift({ isPublished: true, startsAt: t("2026-06-15T09:00") }),
          now: t("2026-06-12T09:00"), // 72h before
        }),
      ),
    ).toEqual([]);
  });

  it("never locks an unpublished draft -- it is not yet a promise to anyone", () => {
    expect(
      checkEditCutoff(
        input({
          shift: shift({ isPublished: false, startsAt: t("2026-06-15T09:00") }),
          now: t("2026-06-15T08:00"),
        }),
      ),
    ).toEqual([]);
  });
});

describe("validateAssignment", () => {
  it("passes a clean assignment with no violations", () => {
    const result = validateAssignment(input());
    expect(result.violations).toEqual([]);
    expect(result.blocked).toBe(false);
    expect(result.requiresOverride).toBe(false);
  });

  it("orders violations by severity so the blocking reason is read first", () => {
    const result = validateAssignment(
      input({
        staff: staff({ skillIds: [] }),
        shift: shift({ startsAt: t("2026-06-15T06:00"), endsAt: t("2026-06-15T19:00") }),
      }),
    );

    expect(result.blocked).toBe(true);
    expect(result.violations[0].severity).toBe("block");
    const severities = result.violations.map((v) => v.severity);
    expect(severities).toEqual([...severities].sort());
  });

  it("separates an override requirement from a hard block", () => {
    const sixPriorDays = [10, 11, 12, 13, 14, 15].map((day, i) => ({
      id: `o-${i}`,
      shiftId: `os-${i}`,
      startsAt: t(`2026-06-${day}T09:00`),
      endsAt: t(`2026-06-${day}T14:00`),
      locationName: "Coastal Eats Venice",
      locationTimezone: LA,
    }));

    const result = validateAssignment(
      input({
        shift: shift({ startsAt: t("2026-06-16T09:00"), endsAt: t("2026-06-16T14:00") }),
        existing: sixPriorDays,
      }),
    );

    expect(result.blocked).toBe(false);
    expect(result.requiresOverride).toBe(true);
    expect(result.overrideCodes).toContain("CONSECUTIVE_DAYS_OVERRIDE");
  });

  it("always returns a projection, so the what-if preview needs no second call", () => {
    const result = validateAssignment(input());
    expect(result.projection.dailyHoursAfter).toBe(8);
    expect(result.projection.weeklyHoursAfter).toBe(8);
    expect(result.consecutive.length).toBe(1);
  });
});
