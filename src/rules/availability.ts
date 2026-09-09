import { DateTime } from "luxon";
import {
  contains,
  intersect,
  normalize,
  subtract,
  uncovered,
  union,
  type Interval,
} from "./interval";

/**
 * Staff availability, expanded into concrete instants.
 *
 * ---------------------------------------------------------------------------
 * The timezone rule that makes all of this coherent
 * ---------------------------------------------------------------------------
 * Availability is anchored to the STAFF MEMBER'S timezone, not the location's.
 * "I'm free 9am-5pm" is a statement about the speaker's own clock. A person
 * certified at a Pacific location and an Eastern one has one set of availability
 * windows, and those windows land differently against each location's local
 * hours -- which is the whole substance of the brief's "Timezone Tangle".
 *
 * ---------------------------------------------------------------------------
 * Why minutes-from-midnight are rebuilt as WALL CLOCK, never added to midnight
 * ---------------------------------------------------------------------------
 * A window is stored as minutes from local midnight. It is tempting to expand
 * it as `startOfDay.plus({ minutes })`. That is wrong, and measurably so:
 *
 *   America/Los_Angeles, 2026-03-08 (spring forward, a 23-hour day)
 *     midnight.plus({ minutes: 540 })  ->  10:00  WRONG
 *     wall-clock 09:00                 ->  09:00  RIGHT
 *
 * Adding elapsed minutes across a skipped hour slides the window by an hour, so
 * every staff member's stated availability would silently shift twice a year.
 * `wallClockInstant` therefore converts the offset into a calendar day plus an
 * hour/minute and constructs that wall-clock time in the target zone.
 *
 * ---------------------------------------------------------------------------
 * DST boundary behaviour (verified against Luxon, not assumed)
 * ---------------------------------------------------------------------------
 *   Nonexistent local time (02:30 on spring-forward): Luxon maps it forward to
 *   the first instant that exists (03:30). A window opening inside the skipped
 *   hour therefore opens as soon as the clock allows.
 *
 *   Ambiguous local time (01:30 on fall-back, which happens twice): Luxon
 *   resolves to the FIRST occurrence (the pre-transition offset). We keep that:
 *   it makes the window start earlier, which is the reading that favours the
 *   staff member rather than silently shortening their stated availability.
 */

export interface AvailabilityRule {
  /** ISO-8601 weekday: 1 = Monday ... 7 = Sunday (matches Luxon's `weekday`). */
  isoWeekday: number;
  /** Minutes from local midnight, 0..1439. */
  startMinute: number;
  /** Minutes from local midnight; may exceed 1440 to express a window past midnight. */
  endMinute: number;
  /** IANA zone this window is expressed in. */
  timezone: string;
}

export interface AvailabilityException {
  /** Local calendar date, 'YYYY-MM-DD', interpreted in `timezone`. */
  date: string;
  /** false = carve availability out; true = add availability beyond the recurring rules. */
  isAvailable: boolean;
  /** null on both bounds means the whole local day. */
  startMinute: number | null;
  endMinute: number | null;
  timezone: string;
}

export interface AvailabilityVerdict {
  isAvailable: boolean;
  /** The parts of the requested span not covered -- what a violation message quotes. */
  gaps: Interval[];
  /** The availability windows considered, clipped to the requested span. */
  windows: Interval[];
}

const MINUTES_PER_DAY = 1440;

/**
 * Resolve "N minutes from local midnight on `base`" to an instant, treating N as
 * a wall-clock offset. Offsets of 1440+ roll onto following calendar days.
 */
function wallClockInstant(base: DateTime, minute: number): number {
  const dayOffset = Math.floor(minute / MINUTES_PER_DAY);
  const withinDay = minute % MINUTES_PER_DAY;
  const day = base.plus({ days: dayOffset });

  return DateTime.fromObject(
    {
      year: day.year,
      month: day.month,
      day: day.day,
      hour: Math.floor(withinDay / 60),
      minute: withinDay % 60,
    },
    { zone: base.zone },
  ).toMillis();
}

/**
 * Local calendar days that could contribute a window overlapping `span`.
 *
 * Padded by a day on each side: a window declared on Friday can run to 02:00
 * Saturday, so Friday's rule must be considered for a Saturday-morning shift.
 */
function localDaysSpanning(span: Interval, zone: string): DateTime[] {
  const first = DateTime.fromMillis(span.start, { zone }).startOf("day").minus({ days: 1 });
  const last = DateTime.fromMillis(span.end, { zone }).startOf("day").plus({ days: 1 });

  const days: DateTime[] = [];
  for (let day = first; day <= last; day = day.plus({ days: 1 })) {
    days.push(day);
  }
  return days;
}

/**
 * Expand recurring rules and one-off exceptions into the availability windows
 * that intersect `span`.
 *
 * Exceptions always win over recurring rules for their local date: additions are
 * unioned in, then all removals are subtracted, so an "unavailable" exception
 * cannot be reinstated by an overlapping recurring rule.
 */
export function availableIntervals(
  rules: AvailabilityRule[],
  exceptions: AvailabilityException[],
  span: Interval,
): Interval[] {
  const recurring: Interval[] = [];

  for (const rule of rules) {
    for (const day of localDaysSpanning(span, rule.timezone)) {
      if (day.weekday !== rule.isoWeekday) continue;
      recurring.push({
        start: wallClockInstant(day, rule.startMinute),
        end: wallClockInstant(day, rule.endMinute),
      });
    }
  }

  const additions: Interval[] = [];
  const removals: Interval[] = [];

  for (const exception of exceptions) {
    const day = DateTime.fromISO(exception.date, { zone: exception.timezone }).startOf("day");
    if (!day.isValid) continue;

    // Whole-day exception. The database forbids an "available all day" shape
    // (an addition must name a window), so this is always a removal.
    if (exception.startMinute === null || exception.endMinute === null) {
      removals.push({ start: day.toMillis(), end: day.plus({ days: 1 }).toMillis() });
      continue;
    }

    const window: Interval = {
      start: wallClockInstant(day, exception.startMinute),
      end: wallClockInstant(day, exception.endMinute),
    };
    (exception.isAvailable ? additions : removals).push(window);
  }

  const declared = union(normalize(recurring), normalize(additions));
  return intersect(subtract(declared, removals), [span]);
}

/** Is the staff member available for the whole of `span`, and if not, where not? */
export function checkAvailability(
  rules: AvailabilityRule[],
  exceptions: AvailabilityException[],
  span: Interval,
): AvailabilityVerdict {
  const windows = availableIntervals(rules, exceptions, span);
  return {
    isAvailable: contains(windows, span),
    gaps: uncovered(windows, span),
    windows,
  };
}
