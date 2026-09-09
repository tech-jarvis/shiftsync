import { sql } from "@/db/client";
import { requireUser } from "@/lib/auth";
import { AvailabilityEditor, type ExceptionRow, type RuleRow } from "@/components/staff/AvailabilityEditor";

/**
 * A staff member's own availability.
 *
 * Windows are entered and displayed in the person's OWN timezone, stated
 * plainly at the top. That is the whole substance of the brief's "Timezone
 * Tangle": "9am-5pm" is a claim about your own clock, and the system converts
 * it to each location's hours rather than assuming they agree.
 */
export default async function AvailabilityPage() {
  const user = await requireUser();

  const [rules, exceptions] = await Promise.all([
    sql<RuleRow[]>`
      select id, iso_weekday as "isoWeekday", start_minute as "startMinute",
             end_minute as "endMinute"
        from availability_rules
       where staff_id = ${user.profileId}
       order by iso_weekday, start_minute
    `,
    sql<ExceptionRow[]>`
      select id, to_char(on_date, 'YYYY-MM-DD') as "date", is_available as "isAvailable",
             start_minute as "startMinute", end_minute as "endMinute", reason
        from availability_exceptions
       where staff_id = ${user.profileId}
         and on_date >= current_date - 7
       order by on_date
    `,
  ]);

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">My availability</h1>
        <p className="text-sm text-[var(--text-muted)] mt-0.5">
          All times are in your own timezone,{" "}
          <strong className="text-[var(--text)]">{user.homeTimezone.replace("_", " ")}</strong>.
          When you are scheduled somewhere in a different zone, these hours are converted — so
          9am here is not 9am there.
        </p>
      </header>

      <AvailabilityEditor rules={rules} exceptions={exceptions} timezone={user.homeTimezone} />
    </div>
  );
}
