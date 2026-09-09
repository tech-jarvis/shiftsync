import { DateTime } from "luxon";
import { sql } from "@/db/client";
import { requireRole } from "@/lib/auth";

/**
 * The audit trail, for admins.
 *
 * Every row here was written by a database trigger inside the same transaction
 * as the change it records -- not by application code that could forget. That
 * is why entries exist for changes made in psql or Studio too.
 */

const PAGE_SIZE = 100;

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; location?: string }>;
}) {
  await requireRole("admin");
  const params = await searchParams;

  const from = params.from ?? DateTime.now().minus({ days: 30 }).toFormat("yyyy-MM-dd");
  const to = params.to ?? DateTime.now().toFormat("yyyy-MM-dd");
  const locationId = params.location ?? "";

  const locations = await sql<{ id: string; name: string }[]>`
    select id, name from locations order by name
  `;

  const rows = await sql<
    {
      id: string;
      occurredAt: Date;
      actorName: string | null;
      entityType: string;
      action: string;
      locationName: string | null;
      summary: string | null;
    }[]
  >`
    select al.id,
           al.occurred_at as "occurredAt",
           p.full_name    as "actorName",
           al.entity_type as "entityType",
           al.action,
           l.name         as "locationName",
           coalesce(
             (select string_agg(key, ', ' order by key)
                from jsonb_each(coalesce(al.after_state, '{}'::jsonb)) e(key, value)
               where al.before_state is not null
                 and al.before_state -> key is distinct from value
                 and key not in ('updated_at', 'version')),
             ''
           ) as summary
      from audit_log al
      left join profiles p on p.id = al.actor_id
      left join shifts s on s.id = case
             when al.entity_type = 'shifts' then al.entity_id
             else (coalesce(al.after_state, al.before_state) ->> 'shift_id')::uuid
           end
      left join locations l on l.id = s.location_id
     where al.occurred_at >= ${from}::date
       and al.occurred_at <  (${to}::date + 1)
       ${locationId ? sql`and s.location_id = ${locationId}::uuid` : sql``}
     order by al.occurred_at desc
     limit ${PAGE_SIZE}
  `;

  const exportHref = `/api/audit/export?from=${from}&to=${to}${locationId ? `&location=${locationId}` : ""}`;

  return (
    <div className="space-y-4 max-w-6xl">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Audit trail</h1>
          <p className="text-sm text-[var(--text-muted)] mt-0.5">
            Written by database triggers, so every write path is recorded — including changes made
            outside the app.
          </p>
        </div>
        <a href={exportHref} className="btn btn-primary text-xs" download>
          Export CSV
        </a>
      </header>

      <form className="card p-3 flex flex-wrap items-end gap-2" method="get">
        <label className="text-xs">
          <span className="block text-[var(--text-muted)] mb-1">From</span>
          <input type="date" name="from" defaultValue={from} className="field text-xs w-36" />
        </label>
        <label className="text-xs">
          <span className="block text-[var(--text-muted)] mb-1">To</span>
          <input type="date" name="to" defaultValue={to} className="field text-xs w-36" />
        </label>
        <label className="text-xs">
          <span className="block text-[var(--text-muted)] mb-1">Location</span>
          <select name="location" defaultValue={locationId} className="field text-xs w-52">
            <option value="">All locations</option>
            {locations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn text-xs">
          Apply
        </button>
      </form>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] text-[var(--text-subtle)] uppercase tracking-wide">
                <th className="text-left font-medium px-3 py-1.5">When</th>
                <th className="text-left font-medium px-3 py-1.5">Who</th>
                <th className="text-left font-medium px-3 py-1.5">What</th>
                <th className="text-left font-medium px-3 py-1.5">Location</th>
                <th className="text-left font-medium px-3 py-1.5">Fields changed</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-xs text-[var(--text-subtle)] text-center">
                    No audit entries in this range.
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id} className="border-t" style={{ borderColor: "var(--border)" }}>
                    <td className="px-3 py-1.5 tnum whitespace-nowrap text-[var(--text-muted)]">
                      {DateTime.fromJSDate(row.occurredAt).toFormat("d LLL HH:mm:ss")}
                    </td>
                    <td className="px-3 py-1.5">{row.actorName ?? "system"}</td>
                    <td className="px-3 py-1.5">
                      <span
                        className="badge"
                        style={{
                          background:
                            row.action === "delete" ? "var(--block-soft)" : "var(--surface-sunken)",
                          color: row.action === "delete" ? "var(--block)" : "var(--text-muted)",
                        }}
                      >
                        {row.action}
                      </span>{" "}
                      <span className="text-[var(--text-muted)]">{row.entityType}</span>
                    </td>
                    <td className="px-3 py-1.5 text-[var(--text-muted)]">
                      {row.locationName ?? "—"}
                    </td>
                    <td className="px-3 py-1.5 text-xs text-[var(--text-subtle)] max-w-md truncate">
                      {row.summary || "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {rows.length === PAGE_SIZE ? (
          <p className="px-3 py-2 text-[11px] text-[var(--text-subtle)] border-t" style={{ borderColor: "var(--border)" }}>
            Showing the most recent {PAGE_SIZE}. Narrow the date range, or export the full range
            as CSV.
          </p>
        ) : null}
      </div>
    </div>
  );
}
