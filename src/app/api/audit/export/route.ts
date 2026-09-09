import { NextResponse } from "next/server";
import { sql } from "@/db/client";
import { getCurrentUser } from "@/lib/auth";

/**
 * Audit log export.
 *
 * Admin only, and the check is here rather than relying on RLS because this
 * route reads through the privileged connection. The brief asks admins to be
 * able to "export audit logs for any date range and location" -- location
 * filtering resolves through each entity back to its shift, since an audit row
 * is generic and carries no location of its own.
 */

/** RFC 4180: quote everything, double any embedded quotes. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Admins only." }, { status: 403 });
  }

  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const locationId = url.searchParams.get("location");

  if (!from || !to) {
    return NextResponse.json({ error: "from and to dates are required." }, { status: 400 });
  }

  const rows = await sql<
    {
      occurredAt: Date;
      actorName: string | null;
      actorEmail: string | null;
      entityType: string;
      entityId: string | null;
      action: string;
      locationName: string | null;
      beforeState: unknown;
      afterState: unknown;
    }[]
  >`
    select al.occurred_at            as "occurredAt",
           p.full_name               as "actorName",
           p.email                   as "actorEmail",
           al.entity_type            as "entityType",
           al.entity_id              as "entityId",
           al.action,
           l.name                    as "locationName",
           al.before_state           as "beforeState",
           al.after_state            as "afterState"
      from audit_log al
      left join profiles p on p.id = al.actor_id
      -- Resolve a location for the rows that have one, so the filter can work.
      left join shifts s on s.id = case
             when al.entity_type = 'shifts' then al.entity_id
             else (coalesce(al.after_state, al.before_state) ->> 'shift_id')::uuid
           end
      left join locations l on l.id = s.location_id
     where al.occurred_at >= ${from}::date
       and al.occurred_at <  (${to}::date + 1)
       ${locationId ? sql`and s.location_id = ${locationId}::uuid` : sql``}
     order by al.occurred_at
  `;

  const header = [
    "occurred_at",
    "actor_name",
    "actor_email",
    "location",
    "entity_type",
    "entity_id",
    "action",
    "before_state",
    "after_state",
  ];

  const csv = [
    header.join(","),
    ...rows.map((row) =>
      [
        row.occurredAt.toISOString(),
        row.actorName ?? "system",
        row.actorEmail ?? "",
        row.locationName ?? "",
        row.entityType,
        row.entityId ?? "",
        row.action,
        row.beforeState,
        row.afterState,
      ]
        .map(csvCell)
        .join(","),
    ),
  ].join("\n");

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="shiftsync-audit-${from}-to-${to}.csv"`,
    },
  });
}
