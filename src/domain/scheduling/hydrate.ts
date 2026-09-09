import type { Tx } from "@/db/transaction";
import { sql } from "@/db/client";
import {
  DEFAULT_SETTINGS,
  type ExistingAssignment,
  type RuleSettings,
  type ShiftSnapshot,
  type StaffSnapshot,
} from "@/rules";

/**
 * Loading the plain-data snapshots the rules engine consumes.
 *
 * The engine is deliberately database-free, so this module is the only place
 * that knows both worlds. Keeping the seam here is what lets every rule be
 * unit-tested without a database, and what stops query concerns leaking into
 * rule logic.
 *
 * NOTE ON DATE COLUMNS: `date` values are selected with to_char rather than let
 * through as JS Dates. A Postgres `date` arrives as a Date at UTC midnight, so
 * reading it in any negative-offset zone yields the PREVIOUS day -- which would
 * silently shift certification boundaries by one day for every Pacific user.
 */

/** How far around a shift to load assignments: enough for weekly and 7-day-run rules. */
const CONTEXT_WINDOW_DAYS = 10;

export async function loadSettings(tx: Tx | typeof sql = sql): Promise<RuleSettings> {
  const rows = await tx<{ key: string; value: string }[]>`
    select key, value::text from app_settings
  `;

  const byKey = new Map(rows.map((r) => [r.key, Number(r.value)]));
  const read = (key: string, fallback: number) => byKey.get(key) ?? fallback;

  return {
    minRestHours: read("min_rest_hours", DEFAULT_SETTINGS.minRestHours),
    dailyHoursWarn: read("daily_hours_warn", DEFAULT_SETTINGS.dailyHoursWarn),
    dailyHoursBlock: read("daily_hours_block", DEFAULT_SETTINGS.dailyHoursBlock),
    weeklyHoursWarn: read("weekly_hours_warn", DEFAULT_SETTINGS.weeklyHoursWarn),
    weeklyHoursOvertime: read("weekly_hours_overtime", DEFAULT_SETTINGS.weeklyHoursOvertime),
    consecutiveDaysWarn: read("consecutive_days_warn", DEFAULT_SETTINGS.consecutiveDaysWarn),
    consecutiveDaysOverride: read("consecutive_days_override", DEFAULT_SETTINGS.consecutiveDaysOverride),
    editCutoffHours: read("edit_cutoff_hours", DEFAULT_SETTINGS.editCutoffHours),
    maxPendingRequests: read("max_pending_requests", DEFAULT_SETTINGS.maxPendingRequests),
    dropExpiryHours: read("drop_expiry_hours", DEFAULT_SETTINGS.dropExpiryHours),
    premiumStartHour: read("premium_start_hour", DEFAULT_SETTINGS.premiumStartHour),
    weekStartsOn: DEFAULT_SETTINGS.weekStartsOn,
  };
}

export async function loadStaffSnapshot(
  tx: Tx | typeof sql,
  staffId: string,
): Promise<StaffSnapshot | null> {
  const [person] = await tx<
    {
      id: string;
      fullName: string;
      homeTimezone: string;
      desiredWeeklyHours: string | null;
    }[]
  >`
    select id,
           full_name            as "fullName",
           home_timezone        as "homeTimezone",
           desired_weekly_hours as "desiredWeeklyHours"
      from profiles
     where id = ${staffId}
  `;

  if (!person) return null;

  const [skills, certifications, rules, exceptions] = await Promise.all([
    tx<{ skillId: string }[]>`
      select skill_id as "skillId" from staff_skills where staff_id = ${staffId}
    `,
    tx<{ locationId: string; effectiveFrom: string; effectiveTo: string | null }[]>`
      select location_id                        as "locationId",
             to_char(effective_from, 'YYYY-MM-DD') as "effectiveFrom",
             to_char(effective_to,   'YYYY-MM-DD') as "effectiveTo"
        from staff_certifications
       where staff_id = ${staffId}
    `,
    tx<{ isoWeekday: number; startMinute: number; endMinute: number; timezone: string }[]>`
      select iso_weekday   as "isoWeekday",
             start_minute  as "startMinute",
             end_minute    as "endMinute",
             timezone
        from availability_rules
       where staff_id = ${staffId}
    `,
    tx<
      {
        date: string;
        isAvailable: boolean;
        startMinute: number | null;
        endMinute: number | null;
        timezone: string;
      }[]
    >`
      select to_char(on_date, 'YYYY-MM-DD') as "date",
             is_available                   as "isAvailable",
             start_minute                   as "startMinute",
             end_minute                     as "endMinute",
             timezone
        from availability_exceptions
       where staff_id = ${staffId}
    `,
  ]);

  return {
    id: person.id,
    fullName: person.fullName,
    homeTimezone: person.homeTimezone,
    skillIds: skills.map((s) => s.skillId),
    certifications,
    availabilityRules: rules,
    availabilityExceptions: exceptions,
    desiredWeeklyHours:
      person.desiredWeeklyHours === null ? null : Number(person.desiredWeeklyHours),
  };
}

export async function loadShiftSnapshot(
  tx: Tx | typeof sql,
  shiftId: string,
): Promise<ShiftSnapshot | null> {
  const [row] = await tx<
    {
      id: string;
      locationId: string;
      locationName: string;
      locationTimezone: string;
      requiredSkillId: string;
      requiredSkillName: string;
      startsAt: Date;
      endsAt: Date;
      headcount: number;
      filledCount: string;
      isPublished: boolean;
      version: number;
      isPremium: boolean;
    }[]
  >`
    select s.id,
           s.location_id       as "locationId",
           l.name              as "locationName",
           l.timezone          as "locationTimezone",
           s.required_skill_id as "requiredSkillId",
           k.name              as "requiredSkillName",
           s.starts_at         as "startsAt",
           s.ends_at           as "endsAt",
           s.headcount,
           s.is_published      as "isPublished",
           s.version,
           s.is_premium        as "isPremium",
           (select count(*) from assignments a
             where a.shift_id = s.id and a.status = 'active') as "filledCount"
      from shifts s
      join locations l on l.id = s.location_id
      join skills    k on k.id = s.required_skill_id
     where s.id = ${shiftId}
  `;

  if (!row) return null;

  return {
    id: row.id,
    locationId: row.locationId,
    locationName: row.locationName,
    locationTimezone: row.locationTimezone,
    requiredSkillId: row.requiredSkillId,
    requiredSkillName: row.requiredSkillName,
    startsAt: row.startsAt.getTime(),
    endsAt: row.endsAt.getTime(),
    headcount: row.headcount,
    filledCount: Number(row.filledCount),
    isPublished: row.isPublished,
  };
}

/**
 * The staff member's other active assignments near this shift.
 *
 * `excludeAssignmentIds` is what makes swap validation correct: the assignment
 * being given up is omitted, so a straight handoff does not report itself as a
 * double-booking.
 */
export async function loadExistingAssignments(
  tx: Tx | typeof sql,
  options: {
    staffId: string;
    aroundStart: number;
    aroundEnd: number;
    excludeAssignmentIds?: string[];
  },
): Promise<ExistingAssignment[]> {
  const windowStart = new Date(options.aroundStart - CONTEXT_WINDOW_DAYS * 86_400_000);
  const windowEnd = new Date(options.aroundEnd + CONTEXT_WINDOW_DAYS * 86_400_000);
  const excluded = options.excludeAssignmentIds ?? [];

  const rows = await tx<
    {
      id: string;
      shiftId: string;
      startsAt: Date;
      endsAt: Date;
      locationName: string;
      locationTimezone: string;
    }[]
  >`
    select a.id,
           a.shift_id  as "shiftId",
           a.starts_at as "startsAt",
           a.ends_at   as "endsAt",
           l.name      as "locationName",
           l.timezone  as "locationTimezone"
      from assignments a
      join shifts    s on s.id = a.shift_id
      join locations l on l.id = s.location_id
     where a.staff_id = ${options.staffId}
       and a.status   = 'active'
       and a.starts_at >= ${windowStart}
       and a.starts_at <= ${windowEnd}
       ${excluded.length > 0 ? tx`and a.id <> all(${excluded}::uuid[])` : tx``}
  `;

  return rows.map((r) => ({
    id: r.id,
    shiftId: r.shiftId,
    startsAt: r.startsAt.getTime(),
    endsAt: r.endsAt.getTime(),
    locationName: r.locationName,
    locationTimezone: r.locationTimezone,
  }));
}
