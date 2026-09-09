import { DateTime } from "luxon";
import { sql } from "@/db/client";

/**
 * Overtime and fairness analytics.
 *
 * Both answer questions a manager is asked out loud -- "why is payroll up?" and
 * "how come I never get Saturdays?" -- so both are computed from the same
 * assignment rows the schedule is built from, never from a separate rollup that
 * could drift.
 *
 * Hours are aggregated in each STAFF MEMBER'S timezone, matching the rules
 * engine. Premium-shift tagging uses the LOCATION's timezone, because "Friday
 * night" is a property of the restaurant's evening. Those two frames are
 * different on purpose.
 */

/** US convention: hours beyond 40 in a week are paid at 1.5x. */
const OVERTIME_MULTIPLIER = 1.5;
const OVERTIME_THRESHOLD = 40;

export interface StaffWeekRow {
  staffId: string;
  fullName: string;
  hours: number;
  desiredWeeklyHours: number | null;
  hourlyRate: number;
  regularHours: number;
  overtimeHours: number;
  regularCost: number;
  overtimeCost: number;
  totalCost: number;
  consecutiveDays: number;
  /** Shifts that individually tip this person past 40h, most recent first. */
  tippingShifts: { shiftId: string; startsAt: string; locationName: string; hours: number }[];
}

export async function weeklyLabourReport(options: {
  locationIds: string[];
  weekStart: DateTime;
}): Promise<StaffWeekRow[]> {
  const weekStart = options.weekStart.toJSDate();
  const weekEnd = options.weekStart.plus({ days: 7 }).toJSDate();

  const rows = await sql<
    {
      staffId: string;
      fullName: string;
      desiredWeeklyHours: string | null;
      hourlyRate: string;
      shiftId: string;
      startsAt: Date;
      endsAt: Date;
      locationName: string;
      homeTimezone: string;
    }[]
  >`
    select p.id                   as "staffId",
           p.full_name            as "fullName",
           p.desired_weekly_hours as "desiredWeeklyHours",
           p.hourly_rate          as "hourlyRate",
           p.home_timezone        as "homeTimezone",
           s.id                   as "shiftId",
           a.starts_at            as "startsAt",
           a.ends_at              as "endsAt",
           l.name                 as "locationName"
      from assignments a
      join profiles  p on p.id = a.staff_id
      join shifts    s on s.id = a.shift_id
      join locations l on l.id = s.location_id
     where a.status = 'active'
       and a.starts_at >= ${weekStart}
       and a.starts_at <  ${weekEnd}
       and s.location_id = any(${options.locationIds}::uuid[])
     order by a.starts_at
  `;

  const byStaff = new Map<string, StaffWeekRow & { dates: Set<string> }>();

  for (const row of rows) {
    const hours = (row.endsAt.getTime() - row.startsAt.getTime()) / 3_600_000;

    let entry = byStaff.get(row.staffId);
    if (!entry) {
      entry = {
        staffId: row.staffId,
        fullName: row.fullName,
        hours: 0,
        desiredWeeklyHours:
          row.desiredWeeklyHours === null ? null : Number(row.desiredWeeklyHours),
        hourlyRate: Number(row.hourlyRate),
        regularHours: 0,
        overtimeHours: 0,
        regularCost: 0,
        overtimeCost: 0,
        totalCost: 0,
        consecutiveDays: 0,
        tippingShifts: [],
        dates: new Set<string>(),
      };
      byStaff.set(row.staffId, entry);
    }

    const hoursBefore = entry.hours;
    entry.hours += hours;

    // A shift is "tipping" when it crosses the 40h line -- this is the answer to
    // "which specific assignment is pushing them into overtime?", and it is the
    // crossing shift, not merely any shift in an already-over week.
    if (hoursBefore < OVERTIME_THRESHOLD && entry.hours > OVERTIME_THRESHOLD) {
      entry.tippingShifts.push({
        shiftId: row.shiftId,
        startsAt: row.startsAt.toISOString(),
        locationName: row.locationName,
        hours,
      });
    }

    entry.dates.add(
      DateTime.fromJSDate(row.startsAt).setZone(row.homeTimezone).toFormat("yyyy-MM-dd"),
    );
  }

  return [...byStaff.values()]
    .map((entry) => {
      const overtimeHours = Math.max(0, entry.hours - OVERTIME_THRESHOLD);
      const regularHours = entry.hours - overtimeHours;
      const regularCost = regularHours * entry.hourlyRate;
      const overtimeCost = overtimeHours * entry.hourlyRate * OVERTIME_MULTIPLIER;

      return {
        ...entry,
        hours: Math.round(entry.hours * 100) / 100,
        regularHours: Math.round(regularHours * 100) / 100,
        overtimeHours: Math.round(overtimeHours * 100) / 100,
        regularCost: Math.round(regularCost * 100) / 100,
        overtimeCost: Math.round(overtimeCost * 100) / 100,
        totalCost: Math.round((regularCost + overtimeCost) * 100) / 100,
        consecutiveDays: longestRun([...entry.dates]),
      };
    })
    .sort((a, b) => b.hours - a.hours);
}

/** Longest run of consecutive calendar dates in a set of 'YYYY-MM-DD' strings. */
function longestRun(dates: string[]): number {
  const sorted = [...dates].sort();
  let longest = 0;
  let current = 0;
  let previous: DateTime | null = null;

  for (const date of sorted) {
    const day = DateTime.fromISO(date);
    current = previous && day.diff(previous, "days").days === 1 ? current + 1 : 1;
    longest = Math.max(longest, current);
    previous = day;
  }
  return longest;
}

// ---------------------------------------------------------------------------
// Fairness
// ---------------------------------------------------------------------------

export interface FairnessRow {
  staffId: string;
  fullName: string;
  totalShifts: number;
  totalHours: number;
  premiumShifts: number;
  /**
   * Premium shifts held against an equal share of them.
   *   1.0  = exactly their share
   *   0.0  = never gets one
   *   2.0  = twice their share
   */
  premiumShare: number;
  desiredWeeklyHours: number | null;
  /** Average weekly hours over the period, against their stated target. */
  averageWeeklyHours: number;
}

export interface FairnessReport {
  rows: FairnessRow[];
  totalPremiumShifts: number;
  /**
   * Gini coefficient of premium-shift distribution.
   *   0.0 = perfectly even
   *   1.0 = one person takes everything
   * Reported alongside the raw counts, never instead of them: a single number
   * settles no argument on its own, but it does say whether there is one.
   */
  premiumGini: number;
  weeks: number;
}

export async function fairnessReport(options: {
  locationIds: string[];
  from: DateTime;
  to: DateTime;
}): Promise<FairnessReport> {
  const rows = await sql<
    {
      staffId: string;
      fullName: string;
      desiredWeeklyHours: string | null;
      totalShifts: string;
      totalHours: string;
      premiumShifts: string;
    }[]
  >`
    select p.id                   as "staffId",
           p.full_name            as "fullName",
           p.desired_weekly_hours as "desiredWeeklyHours",
           count(*)                                        as "totalShifts",
           sum(extract(epoch from (a.ends_at - a.starts_at)) / 3600) as "totalHours",
           count(*) filter (where s.is_premium)            as "premiumShifts"
      from assignments a
      join profiles  p on p.id = a.staff_id
      join shifts    s on s.id = a.shift_id
     where a.status = 'active'
       and a.starts_at >= ${options.from.toJSDate()}
       and a.starts_at <  ${options.to.toJSDate()}
       and s.location_id = any(${options.locationIds}::uuid[])
     group by p.id, p.full_name, p.desired_weekly_hours
     order by p.full_name
  `;

  const weeks = Math.max(1, options.to.diff(options.from, "weeks").weeks);
  const totalPremium = rows.reduce((sum, r) => sum + Number(r.premiumShifts), 0);
  const equalShare = rows.length > 0 ? totalPremium / rows.length : 0;

  const enriched: FairnessRow[] = rows.map((row) => {
    const premiumShifts = Number(row.premiumShifts);
    const totalHours = Number(row.totalHours);

    return {
      staffId: row.staffId,
      fullName: row.fullName,
      totalShifts: Number(row.totalShifts),
      totalHours: Math.round(totalHours * 10) / 10,
      premiumShifts,
      premiumShare: equalShare > 0 ? Math.round((premiumShifts / equalShare) * 100) / 100 : 0,
      desiredWeeklyHours:
        row.desiredWeeklyHours === null ? null : Number(row.desiredWeeklyHours),
      averageWeeklyHours: Math.round((totalHours / weeks) * 10) / 10,
    };
  });

  return {
    rows: enriched.sort((a, b) => b.premiumShifts - a.premiumShifts),
    totalPremiumShifts: totalPremium,
    premiumGini: gini(enriched.map((r) => r.premiumShifts)),
    weeks: Math.round(weeks * 10) / 10,
  };
}

function gini(values: number[]): number {
  if (values.length === 0) return 0;
  const total = values.reduce((sum, v) => sum + v, 0);
  if (total === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const weighted = sorted.reduce((sum, value, index) => sum + (index + 1) * value, 0);

  return Math.round(((2 * weighted) / (n * total) - (n + 1) / n) * 1000) / 1000;
}
