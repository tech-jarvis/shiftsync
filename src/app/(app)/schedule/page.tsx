import { DateTime } from "luxon";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { WeekGrid, type ShiftView } from "@/components/schedule/WeekGrid";
import { PublishControls } from "@/components/schedule/PublishControls";

/**
 * The manager's week view for one location.
 *
 * Scoped to a single location on purpose. A shift's hours only mean anything in
 * its location's timezone, and stacking two timezones into one grid forces the
 * reader to do offset arithmetic in their head on every glance. The location
 * switcher is one click, and the timezone is stated in the header.
 */

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ location?: string; week?: string }>;
}) {
  const user = await requireRole("manager", "admin");
  const params = await searchParams;
  const supabase = await createClient();

  const { data: allLocations } = await supabase
    .from("locations")
    .select("id, name, timezone")
    .order("name");

  const locations = (allLocations ?? []).filter(
    (l) => user.role === "admin" || user.locationIds.includes(l.id),
  );

  if (locations.length === 0) {
    return (
      <p className="text-sm text-[var(--text-muted)]">
        You are not assigned to any locations yet.
      </p>
    );
  }

  const location = locations.find((l) => l.id === params.location) ?? locations[0];

  // The week is anchored in the LOCATION's timezone: "this week" at a Portland
  // restaurant is not the same seven instants as at a Santa Monica one.
  const anchor = params.week
    ? DateTime.fromISO(params.week, { zone: location.timezone })
    : DateTime.now().setZone(location.timezone);
  const weekStart = anchor.startOf("day").minus({ days: anchor.weekday - 1 });
  const weekEnd = weekStart.plus({ days: 7 });

  const { data: rows, error: shiftsError } = await supabase
    .from("shifts")
    .select(
      // `assignments` has two foreign keys to `profiles` (staff_id and
      // assigned_by), so the relationship must be named explicitly -- PostgREST
      // refuses to guess, and rightly so.
      `id, starts_at, ends_at, headcount, is_published, is_premium, version, notes,
       skill:skills(id, name),
       assignments(id, status, staff:profiles!assignments_staff_id_fkey(id, full_name))`,
    )
    .eq("location_id", location.id)
    .gte("starts_at", weekStart.toISO()!)
    .lt("starts_at", weekEnd.toISO()!)
    .order("starts_at");

  // Surfacing this matters: a failed query and a genuinely empty week both
  // produce zero rows, and rendering "No shifts" for a broken query sends the
  // manager looking for a scheduling problem that does not exist.
  if (shiftsError) {
    return (
      <div
        className="card p-4 text-sm"
        style={{ borderColor: "var(--block)", background: "var(--block-soft)" }}
      >
        <p className="font-semibold" style={{ color: "var(--block)" }}>
          The schedule could not be loaded.
        </p>
        <p className="text-[var(--text-muted)] mt-1">{shiftsError.message}</p>
      </div>
    );
  }

  const shifts: ShiftView[] = (rows ?? []).map((row) => {
    const skill = row.skill as unknown as { id: string; name: string } | null;
    const assignments = (row.assignments ?? []) as unknown as {
      id: string;
      status: string;
      staff: { id: string; full_name: string } | null;
    }[];

    return {
      id: row.id,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      headcount: row.headcount,
      isPublished: row.is_published,
      isPremium: row.is_premium,
      skillName: skill?.name ?? "—",
      assignments: assignments
        .filter((a) => a.status === "active" && a.staff)
        .map((a) => ({ id: a.id, staffId: a.staff!.id, fullName: a.staff!.full_name })),
    };
  });

  const unpublishedCount = shifts.filter((s) => !s.isPublished).length;
  const understaffed = shifts.filter((s) => s.assignments.length < s.headcount).length;

  const weekLink = (offset: number) =>
    `/schedule?location=${location.id}&week=${weekStart.plus({ weeks: offset }).toISODate()}`;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-lg font-semibold tracking-tight">{location.name}</h1>
            <span
              className="badge"
              style={{ background: "var(--surface-sunken)", color: "var(--text-muted)" }}
            >
              {location.timezone.replace("America/", "").replace("_", " ")}
            </span>
          </div>
          <p className="text-sm text-[var(--text-muted)] mt-0.5 tnum">
            Week of {weekStart.toFormat("d LLL")} – {weekStart.plus({ days: 6 }).toFormat("d LLL yyyy")}
            {understaffed > 0 ? (
              <>
                {" · "}
                <span style={{ color: "var(--block)" }}>{understaffed} understaffed</span>
              </>
            ) : null}
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1">
            <Link href={weekLink(-1)} className="btn text-xs" aria-label="Previous week">
              ←
            </Link>
            <Link
              href={`/schedule?location=${location.id}`}
              className="btn text-xs"
            >
              Today
            </Link>
            <Link href={weekLink(1)} className="btn text-xs" aria-label="Next week">
              →
            </Link>
          </div>

          <PublishControls
            locationId={location.id}
            weekStartISO={weekStart.toISO()!}
            unpublishedCount={unpublishedCount}
            totalCount={shifts.length}
          />
        </div>
      </header>

      {locations.length > 1 ? (
        <nav className="flex items-center gap-1 flex-wrap">
          {locations.map((l) => (
            <Link
              key={l.id}
              href={`/schedule?location=${l.id}&week=${weekStart.toISODate()}`}
              className="px-2.5 py-1 text-xs rounded-md border"
              style={{
                borderColor: l.id === location.id ? "var(--accent)" : "var(--border)",
                background: l.id === location.id ? "var(--accent-soft)" : "var(--surface-raised)",
                color: l.id === location.id ? "var(--accent)" : "var(--text-muted)",
              }}
            >
              {l.name.replace("Coastal Eats ", "")}
            </Link>
          ))}
        </nav>
      ) : null}

      <WeekGrid
        shifts={shifts}
        weekStartISO={weekStart.toISO()!}
        timezone={location.timezone}
        locationId={location.id}
      />
    </div>
  );
}
