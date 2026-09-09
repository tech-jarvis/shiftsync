import { DateTime } from "luxon";
import { formatDay, hoursLabel, localDateKey } from "./format";
import { totalHours, type Interval } from "./interval";
import {
  assignmentInterval,
  DEFAULT_SETTINGS,
  shiftInterval,
  type ValidationInput,
  type Violation,
} from "./types";

/**
 * Daily and weekly hour rules, plus the projection the "what-if" preview and
 * the overtime dashboard both render.
 *
 * ---------------------------------------------------------------------------
 * Two attribution decisions, both documented in DECISIONS.md
 * ---------------------------------------------------------------------------
 * 1. WHICH DAY does an 11pm-3am shift belong to? Its START date. Splitting it
 *    across two days would make a single continuous shift trip the daily
 *    warning on two separate days while working neither of them fully.
 *
 * 2. WHOSE TIMEZONE defines "a day"? The STAFF MEMBER'S. These are limits on a
 *    person's body, so the person's own calendar is the coherent one. Using
 *    each shift's location zone instead would let one continuous stretch of
 *    work land on two different "days" purely because the two shifts were in
 *    different states -- which is how you get a Pacific-to-Eastern double
 *    that the daily cap never notices.
 *
 * Note that premium-shift tagging goes the other way and uses the LOCATION's
 * zone, because "Friday night" is a property of the restaurant's evening, not
 * of the employee's clock.
 */

export interface HoursProjection {
  /** Local date (staff zone) the candidate shift is attributed to. */
  dayKey: string;
  /** First local date of the labour week containing the candidate. */
  weekStartKey: string;
  dailyHoursBefore: number;
  dailyHoursAfter: number;
  weeklyHoursBefore: number;
  weeklyHoursAfter: number;
  /** Positive when the projection exceeds the staff member's stated desired hours. */
  desiredHoursDelta: number | null;
}

function startOfWeek(dt: DateTime, weekStartsOn: number): DateTime {
  const daysSinceWeekStart = (dt.weekday - weekStartsOn + 7) % 7;
  return dt.startOf("day").minus({ days: daysSinceWeekStart });
}

/**
 * Attribute assignments to local dates in the staff member's zone, keyed by the
 * shift's start date, and total the hours per key.
 */
function hoursByDay(
  spans: Interval[],
  zone: string,
): Map<string, { hours: number; spans: Interval[] }> {
  const byDay = new Map<string, { hours: number; spans: Interval[] }>();

  for (const span of spans) {
    const key = localDateKey(span.start, zone);
    const bucket = byDay.get(key) ?? { hours: 0, spans: [] };
    bucket.spans.push(span);
    bucket.hours = totalHours(bucket.spans);
    byDay.set(key, bucket);
  }

  return byDay;
}

/**
 * What the staff member's daily and weekly totals become if this assignment is
 * saved. This is the single source for the what-if preview -- the numbers the
 * manager sees before confirming are literally the numbers the rules use.
 */
export function projectHours(input: ValidationInput): HoursProjection {
  const { staff, shift, existing, settings = DEFAULT_SETTINGS } = input;
  const zone = staff.homeTimezone;

  const candidate = shiftInterval(shift);
  const existingSpans = existing
    .filter((a) => a.shiftId !== shift.id)
    .map(assignmentInterval);

  const dayKey = localDateKey(candidate.start, zone);
  const weekStart = startOfWeek(DateTime.fromMillis(candidate.start, { zone }), settings.weekStartsOn);
  const weekStartKey = weekStart.toFormat("yyyy-MM-dd");
  const weekEnd = weekStart.plus({ days: 7 });

  const before = hoursByDay(existingSpans, zone);
  const after = hoursByDay([...existingSpans, candidate], zone);

  const inWeek = (key: string) => key >= weekStartKey && key < weekEnd.toFormat("yyyy-MM-dd");
  const weekTotal = (map: Map<string, { hours: number }>) =>
    [...map.entries()].filter(([key]) => inWeek(key)).reduce((sum, [, v]) => sum + v.hours, 0);

  const weeklyHoursAfter = weekTotal(after);

  return {
    dayKey,
    weekStartKey,
    dailyHoursBefore: before.get(dayKey)?.hours ?? 0,
    dailyHoursAfter: after.get(dayKey)?.hours ?? 0,
    weeklyHoursBefore: weekTotal(before),
    weeklyHoursAfter,
    desiredHoursDelta:
      staff.desiredWeeklyHours === null ? null : weeklyHoursAfter - staff.desiredWeeklyHours,
  };
}

/** 8h warns, 12h is a hard block. */
export function checkDailyHours(input: ValidationInput): Violation[] {
  const { staff, settings = DEFAULT_SETTINGS } = input;
  const projection = projectHours(input);
  const { dailyHoursAfter, dayKey } = projection;

  if (dailyHoursAfter > settings.dailyHoursBlock) {
    return [
      {
        code: "DAILY_HOURS_BLOCK",
        severity: "block",
        message:
          `This would put ${staff.fullName} on ${hoursLabel(dailyHoursAfter)} on ` +
          `${formatDay(dayKey, staff.homeTimezone)}, above the ` +
          `${hoursLabel(settings.dailyHoursBlock)} daily maximum.`,
        meta: { ...projection },
      },
    ];
  }

  if (dailyHoursAfter > settings.dailyHoursWarn) {
    return [
      {
        code: "DAILY_HOURS_WARN",
        severity: "warn",
        message:
          `${staff.fullName} would work ${hoursLabel(dailyHoursAfter)} on ` +
          `${formatDay(dayKey, staff.homeTimezone)}, above the ` +
          `${hoursLabel(settings.dailyHoursWarn)} daily guideline.`,
        meta: { ...projection },
      },
    ];
  }

  return [];
}

/**
 * 35h warns; 40h is overtime.
 *
 * Neither blocks. The brief asks the system to "track and warn about" weekly
 * hours -- overtime is a cost decision for a manager to take knowingly, not an
 * illegal state, and blocking it would make the system unusable in exactly the
 * short-staffed week when overtime is the correct answer.
 */
export function checkWeeklyHours(input: ValidationInput): Violation[] {
  const { staff, settings = DEFAULT_SETTINGS } = input;
  const projection = projectHours(input);
  const { weeklyHoursAfter, weeklyHoursBefore } = projection;

  if (weeklyHoursAfter > settings.weeklyHoursOvertime) {
    const overtimeHours = weeklyHoursAfter - settings.weeklyHoursOvertime;
    return [
      {
        code: "WEEKLY_OVERTIME",
        severity: "warn",
        message:
          `This pushes ${staff.fullName} to ${hoursLabel(weeklyHoursAfter)} this week ` +
          `(from ${hoursLabel(weeklyHoursBefore)}), incurring ` +
          `${hoursLabel(overtimeHours)} of overtime above ` +
          `${hoursLabel(settings.weeklyHoursOvertime)}.`,
        meta: { ...projection, overtimeHours },
      },
    ];
  }

  if (weeklyHoursAfter >= settings.weeklyHoursWarn) {
    return [
      {
        code: "WEEKLY_HOURS_WARN",
        severity: "warn",
        message:
          `${staff.fullName} would reach ${hoursLabel(weeklyHoursAfter)} this week, ` +
          `approaching the ${hoursLabel(settings.weeklyHoursOvertime)} overtime threshold.`,
        meta: { ...projection },
      },
    ];
  }

  return [];
}
