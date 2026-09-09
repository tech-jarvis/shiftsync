"use client";

import { DateTime } from "luxon";
import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/browser";

interface OnDutyRow {
  assignmentId: string;
  fullName: string;
  startsAt: string;
  endsAt: string;
  locationId: string;
  locationName: string;
  locationTimezone: string;
  skillName: string;
}

interface LocationGroup {
  id: string;
  name: string;
  timezone: string;
  onNow: OnDutyRow[];
  startingSoon: OnDutyRow[];
}

const SOON_MINUTES = 120;

export function OnDutyBoard({ locationIds }: { locationIds: string[] }) {
  const [rows, setRows] = useState<OnDutyRow[] | null>(null);
  const [now, setNow] = useState(() => DateTime.now());

  const load = useCallback(async () => {
    const supabase = createClient();
    const from = DateTime.now().minus({ hours: 26 }).toISO();
    const to = DateTime.now().plus({ hours: 4 }).toISO();

    const { data } = await supabase
      .from("assignments")
      .select(
        `id, starts_at, ends_at,
         staff:profiles!assignments_staff_id_fkey(full_name),
         shift:shifts!assignments_shift_id_fkey(
           location:locations(id, name, timezone),
           skill:skills(name)
         )`,
      )
      .eq("status", "active")
      .gte("starts_at", from)
      .lte("starts_at", to)
      .order("starts_at");

    setRows(
      (data ?? []).map((row) => {
        const shift = row.shift as unknown as {
          location: { id: string; name: string; timezone: string } | null;
          skill: { name: string } | null;
        };
        const staff = row.staff as unknown as { full_name: string } | null;
        return {
          assignmentId: row.id,
          fullName: staff?.full_name ?? "—",
          startsAt: row.starts_at,
          endsAt: row.ends_at,
          locationId: shift.location?.id ?? "",
          locationName: shift.location?.name ?? "—",
          locationTimezone: shift.location?.timezone ?? "UTC",
          skillName: shift.skill?.name ?? "—",
        };
      }),
    );
  }, []);

  useEffect(() => {
    void load();

    const supabase = createClient();
    const channel = supabase
      .channel("on-duty")
      .on("postgres_changes", { event: "*", schema: "public", table: "assignments" }, () =>
        void load(),
      )
      .subscribe();

    // The clock moves even when the database does not: a shift ending at 23:00
    // produces no row change, so without this tick the board would keep showing
    // someone as on duty indefinitely.
    const timer = setInterval(() => setNow(DateTime.now()), 30_000);

    return () => {
      clearInterval(timer);
      void supabase.removeChannel(channel);
    };
  }, [load]);

  const groups: LocationGroup[] = [];
  for (const row of rows ?? []) {
    if (locationIds.length > 0 && !locationIds.includes(row.locationId)) continue;

    let group = groups.find((g) => g.id === row.locationId);
    if (!group) {
      group = {
        id: row.locationId,
        name: row.locationName,
        timezone: row.locationTimezone,
        onNow: [],
        startingSoon: [],
      };
      groups.push(group);
    }

    const start = DateTime.fromISO(row.startsAt);
    const end = DateTime.fromISO(row.endsAt);

    if (start <= now && now < end) group.onNow.push(row);
    else if (start > now && start.diff(now, "minutes").minutes <= SOON_MINUTES) {
      group.startingSoon.push(row);
    }
  }
  groups.sort((a, b) => a.name.localeCompare(b.name));

  const totalOnDuty = groups.reduce((sum, g) => sum + g.onNow.length, 0);

  return (
    <div className="space-y-4 max-w-5xl">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">On duty now</h1>
          <p className="text-sm text-[var(--text-muted)] mt-0.5 tnum">
            {rows === null
              ? "Loading…"
              : `${totalOnDuty} ${totalOnDuty === 1 ? "person" : "people"} working right now`}
          </p>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-[var(--text-subtle)] tnum">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: "var(--ok)" }}
            aria-hidden
          />
          Live · {now.toFormat("HH:mm:ss")}
        </div>
      </header>

      {rows !== null && groups.length === 0 ? (
        <p className="text-sm text-[var(--text-subtle)]">
          Nobody is scheduled around now at your locations.
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        {groups.map((group) => (
          <section key={group.id} className="card p-3">
            <header className="flex items-baseline justify-between mb-2">
              <h2 className="text-sm font-semibold">{group.name}</h2>
              <span className="text-[11px] text-[var(--text-subtle)]">
                {now.setZone(group.timezone).toFormat("HH:mm")} local
              </span>
            </header>

            {group.onNow.length === 0 ? (
              <p className="text-xs text-[var(--text-subtle)]">Nobody on duty.</p>
            ) : (
              <ul className="space-y-1.5">
                {group.onNow.map((row) => {
                  const end = DateTime.fromISO(row.endsAt);
                  const remaining = Math.max(0, Math.round(end.diff(now, "minutes").minutes));
                  return (
                    <li
                      key={row.assignmentId}
                      className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5"
                      style={{ background: "var(--ok-soft)" }}
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{row.fullName}</div>
                        <div className="text-[11px] text-[var(--text-muted)]">{row.skillName}</div>
                      </div>
                      <div className="text-[11px] tnum text-right shrink-0" style={{ color: "var(--ok)" }}>
                        until{" "}
                        {DateTime.fromISO(row.endsAt).setZone(group.timezone).toFormat("HH:mm")}
                        <div className="text-[var(--text-subtle)]">
                          {remaining >= 60
                            ? `${Math.floor(remaining / 60)}h ${remaining % 60}m left`
                            : `${remaining}m left`}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {group.startingSoon.length > 0 ? (
              <div className="mt-2 pt-2 border-t" style={{ borderColor: "var(--border)" }}>
                <p className="text-[11px] font-medium text-[var(--text-muted)] mb-1">
                  Starting within 2 hours
                </p>
                <ul className="space-y-0.5">
                  {group.startingSoon.map((row) => (
                    <li key={row.assignmentId} className="text-xs flex justify-between gap-2 tnum">
                      <span className="truncate">{row.fullName}</span>
                      <span className="text-[var(--text-subtle)] shrink-0">
                        {DateTime.fromISO(row.startsAt).setZone(group.timezone).toFormat("HH:mm")}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        ))}
      </div>
    </div>
  );
}
