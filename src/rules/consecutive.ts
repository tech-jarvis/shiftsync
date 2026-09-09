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
 * Consecutive days worked.
 *
 * ---------------------------------------------------------------------------
 * Decisions the brief deliberately leaves open (all in DECISIONS.md)
 * ---------------------------------------------------------------------------
 * DOES A 1-HOUR SHIFT COUNT THE SAME AS AN 11-HOUR ONE?  Yes -- for the day
 * count. A day on which you were required to travel to work and be present is
 * a day not rested, which is what consecutive-day protections exist to limit,
 * and it matches how labour rules are written. But severity is not the same in
 * substance, so the run's hours travel in `meta` and are printed in the
 * message, letting a manager see that a 6th day of 1h differs from 11h without
 * the rule quietly ignoring the short shift.
 *
 * RUNS ARE NOT RESET AT THE WEEK BOUNDARY. The brief says "6th consecutive day
 * worked in a week", but a run spanning Sunday into Monday is exactly as tiring
 * as one inside a single week. Counting the true run is the more protective
 * reading, and never under-reports.
 *
 * Days are keyed in the STAFF MEMBER'S timezone, consistent with the daily and
 * weekly hour rules.
 */

export interface ConsecutiveRun {
  /** Consecutive local dates worked, including the candidate's date. */
  dates: string[];
  length: number;
  /** Total hours across the run -- context for how severe the run really is. */
  totalHours: number;
  /** Where in the run the candidate shift's date sits (1-based). */
  candidatePosition: number;
}

const shiftDay = (key: string, days: number, zone: string) =>
  DateTime.fromISO(key, { zone }).plus({ days }).toFormat("yyyy-MM-dd");

/**
 * The unbroken run of worked days containing the candidate shift's date, walking
 * outward in both directions until a rest day is found.
 */
export function consecutiveRun(input: ValidationInput): ConsecutiveRun {
  const { staff, shift, existing } = input;
  const zone = staff.homeTimezone;

  const candidate = shiftInterval(shift);
  const spans: Interval[] = [
    candidate,
    ...existing.filter((a) => a.shiftId !== shift.id).map(assignmentInterval),
  ];

  const hoursByDay = new Map<string, Interval[]>();
  for (const span of spans) {
    const key = localDateKey(span.start, zone);
    hoursByDay.set(key, [...(hoursByDay.get(key) ?? []), span]);
  }

  const candidateKey = localDateKey(candidate.start, zone);
  const worked = new Set(hoursByDay.keys());

  const dates = [candidateKey];
  for (let k = shiftDay(candidateKey, -1, zone); worked.has(k); k = shiftDay(k, -1, zone)) {
    dates.unshift(k);
  }
  for (let k = shiftDay(candidateKey, 1, zone); worked.has(k); k = shiftDay(k, 1, zone)) {
    dates.push(k);
  }

  return {
    dates,
    length: dates.length,
    totalHours: dates.reduce((sum, key) => sum + totalHours(hoursByDay.get(key) ?? []), 0),
    candidatePosition: dates.indexOf(candidateKey) + 1,
  };
}

/** 6 consecutive days warns; 7 requires a documented manager override. */
export function checkConsecutiveDays(input: ValidationInput): Violation[] {
  const { staff, settings = DEFAULT_SETTINGS } = input;
  const run = consecutiveRun(input);
  const zone = staff.homeTimezone;

  if (run.length < settings.consecutiveDaysWarn) return [];

  const span =
    `${formatDay(run.dates[0], zone)} to ${formatDay(run.dates[run.dates.length - 1], zone)}`;
  const context = `${run.length} days totalling ${hoursLabel(run.totalHours)} (${span})`;

  if (run.length >= settings.consecutiveDaysOverride) {
    return [
      {
        code: "CONSECUTIVE_DAYS_OVERRIDE",
        severity: "override_required",
        message:
          `This would be ${staff.fullName}'s ${run.length}th consecutive day worked -- ` +
          `${context}. A ${settings.consecutiveDaysOverride}th consecutive day requires a ` +
          `manager override with a documented reason.`,
        meta: { ...run },
      },
    ];
  }

  return [
    {
      code: "CONSECUTIVE_DAYS_WARN",
      severity: "warn",
      message:
        `This would be ${staff.fullName}'s ${run.length}th consecutive day worked -- ${context}.`,
      meta: { ...run },
    },
  ];
}
