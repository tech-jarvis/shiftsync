import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  availableIntervals,
  checkAvailability,
  type AvailabilityException,
  type AvailabilityRule,
} from "@/rules/availability";
import { durationHours, MS_PER_HOUR } from "@/rules/interval";

const LA = "America/Los_Angeles";
const NY = "America/New_York";

/** An instant from a local ISO datetime in a given zone. */
const at = (iso: string, zone: string) => DateTime.fromISO(iso, { zone }).toMillis();

/** The local wall-clock rendering of an instant, for asserting DST behaviour. */
const wall = (ms: number, zone: string) =>
  DateTime.fromMillis(ms, { zone }).toFormat("yyyy-MM-dd HH:mm");

const minutes = (h: number, m = 0) => h * 60 + m;

/** A 9am-5pm rule in `zone` on the weekday that `date` falls on. */
const nineToFive = (date: string, zone: string): AvailabilityRule => ({
  isoWeekday: DateTime.fromISO(date, { zone }).weekday,
  startMinute: minutes(9),
  endMinute: minutes(17),
  timezone: zone,
});

const daySpan = (date: string, zone: string) => ({
  start: at(`${date}T00:00`, zone),
  end: at(`${date}T00:00`, zone) + 48 * MS_PER_HOUR,
});

describe("recurring availability", () => {
  const date = "2026-06-15";
  const rules = [nineToFive(date, LA)];

  it("covers a shift sitting inside the window", () => {
    const verdict = checkAvailability(rules, [], {
      start: at(`${date}T10:00`, LA),
      end: at(`${date}T14:00`, LA),
    });
    expect(verdict.isAvailable).toBe(true);
    expect(verdict.gaps).toEqual([]);
  });

  it("rejects a shift that runs past the window, and reports the exact gap", () => {
    const verdict = checkAvailability(rules, [], {
      start: at(`${date}T15:00`, LA),
      end: at(`${date}T19:00`, LA),
    });
    expect(verdict.isAvailable).toBe(false);
    expect(verdict.gaps).toHaveLength(1);
    expect(wall(verdict.gaps[0].start, LA)).toBe("2026-06-15 17:00");
    expect(durationHours(verdict.gaps[0])).toBe(2);
  });

  it("does not leak availability onto other weekdays", () => {
    const nextDay = "2026-06-16";
    const verdict = checkAvailability(rules, [], {
      start: at(`${nextDay}T10:00`, LA),
      end: at(`${nextDay}T14:00`, LA),
    });
    expect(verdict.isAvailable).toBe(false);
  });

  it("handles a window running past midnight as one continuous span", () => {
    // Friday 22:00 -> Saturday 02:00, stored as 1320 -> 1560.
    const friday = "2026-06-19";
    const rule: AvailabilityRule = {
      isoWeekday: DateTime.fromISO(friday, { zone: LA }).weekday,
      startMinute: minutes(22),
      endMinute: minutes(26), // 02:00 next day
      timezone: LA,
    };

    const verdict = checkAvailability([rule], [], {
      start: at(`${friday}T23:00`, LA),
      end: at("2026-06-20T01:00", LA),
    });
    expect(verdict.isAvailable).toBe(true);
  });
});

describe("the Timezone Tangle (brief scenario 3)", () => {
  // One staff member, certified in both Pacific and Eastern locations, who has
  // stated availability of "9am-5pm". Their 9am is not the Eastern location's
  // 9am, and the system must reflect that rather than pretending otherwise.
  const monday = "2026-06-15";
  const pacificNineToFive = [nineToFive(monday, LA)];

  it("cannot fully cover a 9am-5pm Eastern shift: their 9am is the location's noon", () => {
    const verdict = checkAvailability(pacificNineToFive, [], {
      start: at(`${monday}T09:00`, NY),
      end: at(`${monday}T17:00`, NY),
    });

    expect(verdict.isAvailable).toBe(false);
    expect(verdict.gaps).toHaveLength(1);
    // The uncovered part is the first three hours of the Eastern shift:
    // 09:00-12:00 Eastern == 06:00-09:00 Pacific, before they are free.
    expect(durationHours(verdict.gaps[0])).toBe(3);
    expect(wall(verdict.gaps[0].start, NY)).toBe("2026-06-15 09:00");
    expect(wall(verdict.gaps[0].end, NY)).toBe("2026-06-15 12:00");
  });

  it("does cover an early-afternoon Eastern shift that lands inside their Pacific window", () => {
    // 13:00-17:00 Eastern == 10:00-14:00 Pacific.
    const verdict = checkAvailability(pacificNineToFive, [], {
      start: at(`${monday}T13:00`, NY),
      end: at(`${monday}T17:00`, NY),
    });
    expect(verdict.isAvailable).toBe(true);
  });

  it("covers the same wall-clock shift at their own Pacific location", () => {
    const verdict = checkAvailability(pacificNineToFive, [], {
      start: at(`${monday}T09:00`, LA),
      end: at(`${monday}T17:00`, LA),
    });
    expect(verdict.isAvailable).toBe(true);
  });
});

describe("daylight saving transitions", () => {
  // US 2026: spring forward Sun 8 Mar (23h day), fall back Sun 1 Nov (25h day).
  const beforeSpring = "2026-03-01";
  const springForward = "2026-03-08";
  const fallBack = "2026-11-01";

  it("keeps a 9am window at 9am local on both sides of the spring transition", () => {
    const rule = nineToFive(springForward, LA); // Sunday
    const before = availableIntervals([rule], [], daySpan(beforeSpring, LA));
    const after = availableIntervals([rule], [], daySpan(springForward, LA));

    expect(wall(before[0].start, LA)).toBe("2026-03-01 09:00");
    expect(wall(after[0].start, LA)).toBe("2026-03-08 09:00");

    // Same wall-clock hour, but a different UTC instant-of-day: PST (-08) before
    // the transition, PDT (-07) after. This is the assertion that fails if the
    // expansion caches a fixed offset.
    const utcHour = (ms: number) => DateTime.fromMillis(ms, { zone: "utc" }).hour;
    expect(utcHour(before[0].start)).toBe(17);
    expect(utcHour(after[0].start)).toBe(16);
  });

  it("opens a window at the first instant that exists when its start hour is skipped", () => {
    // 02:30 does not exist on 2026-03-08 in Los_Angeles; the clock jumps 02:00 -> 03:00.
    const rule: AvailabilityRule = {
      isoWeekday: DateTime.fromISO(springForward, { zone: LA }).weekday,
      startMinute: minutes(2, 30),
      endMinute: minutes(6),
      timezone: LA,
    };
    const windows = availableIntervals([rule], [], daySpan(springForward, LA));

    expect(windows).toHaveLength(1);
    expect(wall(windows[0].start, LA)).toBe("2026-03-08 03:30");
  });

  it("treats a full wall-clock day on the fall-back date as 25 real hours", () => {
    // Midnight to midnight is stored as 0 -> 1440, but on this date that span
    // contains 25 hours of elapsed time. Expanding minutes as wall clock gets
    // this right; adding elapsed minutes to midnight would report 24.
    const rule: AvailabilityRule = {
      isoWeekday: DateTime.fromISO(fallBack, { zone: LA }).weekday,
      startMinute: 0,
      endMinute: 1440,
      timezone: LA,
    };
    const windows = availableIntervals([rule], [], daySpan(fallBack, LA));

    expect(windows).toHaveLength(1);
    expect(durationHours(windows[0])).toBe(25);
  });

  it("treats a full wall-clock day on the spring-forward date as 23 real hours", () => {
    const rule: AvailabilityRule = {
      isoWeekday: DateTime.fromISO(springForward, { zone: LA }).weekday,
      startMinute: 0,
      endMinute: 1440,
      timezone: LA,
    };
    const windows = availableIntervals([rule], [], daySpan(springForward, LA));
    expect(durationHours(windows[0])).toBe(23);
  });
});

describe("one-off exceptions", () => {
  const date = "2026-06-15";
  const rules = [nineToFive(date, LA)];

  const exception = (over: Partial<AvailabilityException>): AvailabilityException => ({
    date,
    isAvailable: false,
    startMinute: null,
    endMinute: null,
    timezone: LA,
    ...over,
  });

  it("removes the whole day when unavailable with no window (called out sick)", () => {
    const verdict = checkAvailability(rules, [exception({})], {
      start: at(`${date}T10:00`, LA),
      end: at(`${date}T14:00`, LA),
    });
    expect(verdict.isAvailable).toBe(false);
    expect(verdict.windows).toEqual([]);
  });

  it("carves a hole out of the middle of a recurring window", () => {
    const verdict = checkAvailability(
      rules,
      [exception({ startMinute: minutes(12), endMinute: minutes(13) })],
      { start: at(`${date}T10:00`, LA), end: at(`${date}T14:00`, LA) },
    );

    expect(verdict.isAvailable).toBe(false);
    expect(verdict.gaps).toHaveLength(1);
    expect(wall(verdict.gaps[0].start, LA)).toBe("2026-06-15 12:00");
    expect(durationHours(verdict.gaps[0])).toBe(1);
  });

  it("adds availability beyond the recurring rules", () => {
    const verdict = checkAvailability(
      rules,
      [exception({ isAvailable: true, startMinute: minutes(17), endMinute: minutes(21) })],
      { start: at(`${date}T16:00`, LA), end: at(`${date}T20:00`, LA) },
    );
    expect(verdict.isAvailable).toBe(true);
  });

  it("lets a removal win over an overlapping addition", () => {
    // Both an added window and a whole-day removal for the same date: the
    // removal must win, otherwise "I'm sick today" could be overridden by a
    // stale extra-availability row.
    const verdict = checkAvailability(
      rules,
      [
        exception({ isAvailable: true, startMinute: minutes(17), endMinute: minutes(21) }),
        exception({}),
      ],
      { start: at(`${date}T18:00`, LA), end: at(`${date}T20:00`, LA) },
    );
    expect(verdict.isAvailable).toBe(false);
  });

  it("applies an exception only to its own date", () => {
    const nextWeek = "2026-06-22";
    const verdict = checkAvailability(rules, [exception({})], {
      start: at(`${nextWeek}T10:00`, LA),
      end: at(`${nextWeek}T14:00`, LA),
    });
    expect(verdict.isAvailable).toBe(true);
  });
});

describe("no availability declared", () => {
  it("treats a staff member with no rules as unavailable, not universally available", () => {
    const verdict = checkAvailability([], [], {
      start: at("2026-06-15T10:00", LA),
      end: at("2026-06-15T14:00", LA),
    });
    expect(verdict.isAvailable).toBe(false);
    expect(durationHours(verdict.gaps[0])).toBe(4);
  });
});
