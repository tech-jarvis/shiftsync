"use client";

import { DateTime } from "luxon";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import { AssignPanel } from "./AssignPanel";
import { NewShiftDialog, type SkillOption } from "./NewShiftDialog";

export interface ShiftView {
  id: string;
  startsAt: string;
  endsAt: string;
  headcount: number;
  isPublished: boolean;
  isPremium: boolean;
  skillName: string;
  assignments: { id: string; staffId: string; fullName: string }[];
}

/**
 * The week grid.
 *
 * Every time here is rendered in the LOCATION's timezone, which is the only
 * frame in which "the Friday dinner shift" means anything to the person running
 * that restaurant. An overnight shift shows its end time with a +1 marker
 * rather than being split across two columns -- it is one shift, and splitting
 * it is how systems end up double-counting the hours.
 */
export function WeekGrid({
  shifts,
  weekStartISO,
  timezone,
  locationId,
  skills,
}: {
  shifts: ShiftView[];
  weekStartISO: string;
  timezone: string;
  locationId: string;
  skills: SkillOption[];
}) {
  const router = useRouter();
  const [openShiftId, setOpenShiftId] = useState<string | null>(null);
  const [newShiftDate, setNewShiftDate] = useState<string | null>(null);
  const [liveNotice, setLiveNotice] = useState<string | null>(null);

  // Live updates: another manager's change, or a swap approval, refreshes this
  // grid without a reload. RLS decides which events reach us.
  useEffect(() => {
    const supabase = createClient();

    const channel = supabase
      .channel(`schedule:${locationId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "assignments" },
        () => {
          setLiveNotice("Schedule updated");
          router.refresh();
          setTimeout(() => setLiveNotice(null), 2500);
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "shifts", filter: `location_id=eq.${locationId}` },
        () => {
          setLiveNotice("Schedule updated");
          router.refresh();
          setTimeout(() => setLiveNotice(null), 2500);
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [locationId, router]);

  const weekStart = DateTime.fromISO(weekStartISO, { zone: timezone });
  const days = Array.from({ length: 7 }, (_, i) => weekStart.plus({ days: i }));
  const today = DateTime.now().setZone(timezone).toISODate();

  const shiftsOn = (day: DateTime) =>
    shifts.filter(
      (s) => DateTime.fromISO(s.startsAt, { zone: timezone }).toISODate() === day.toISODate(),
    );

  const openShift = shifts.find((s) => s.id === openShiftId) ?? null;

  return (
    <>
      {liveNotice ? (
        <div
          className="fixed bottom-4 right-4 z-50 rounded-lg px-3 py-2 text-xs font-medium shadow-lg"
          style={{ background: "var(--accent)", color: "#fff" }}
          role="status"
        >
          {liveNotice}
        </div>
      ) : null}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 gap-2">
        {days.map((day) => {
          const dayShifts = shiftsOn(day);
          const isToday = day.toISODate() === today;

          return (
            <section
              key={day.toISODate()}
              className="card p-2 min-h-[8rem]"
              style={isToday ? { borderColor: "var(--accent)" } : undefined}
            >
              <header className="flex items-baseline justify-between mb-2 px-0.5">
                <span className="text-xs font-semibold">{day.toFormat("ccc")}</span>
                <span className="flex items-center gap-1.5">
                  <span className="text-xs text-[var(--text-subtle)] tnum">
                    {day.toFormat("d LLL")}
                  </span>
                  {/* A generous hit target: the glyph is small, but a 24px
                      box is what the pointer actually has to find. */}
                  <button
                    type="button"
                    onClick={() => setNewShiftDate(day.toISODate())}
                    className="-my-1 -mr-1 h-6 w-6 grid place-items-center rounded text-[var(--text-subtle)] hover:text-[var(--accent)] hover:bg-[var(--surface-sunken)] leading-none text-sm"
                    aria-label={`Add a shift on ${day.toFormat("EEEE d LLLL")}`}
                    title="Add a shift"
                  >
                    +
                  </button>
                </span>
              </header>

              {dayShifts.length === 0 ? (
                <p className="text-[11px] text-[var(--text-subtle)] px-0.5">No shifts</p>
              ) : (
                <ul className="space-y-1.5">
                  {dayShifts.map((shift) => (
                    <li key={shift.id}>
                      <ShiftCard
                        shift={shift}
                        timezone={timezone}
                        onOpen={() => setOpenShiftId(shift.id)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>

      {openShift ? (
        <AssignPanel
          shift={openShift}
          timezone={timezone}
          onClose={() => setOpenShiftId(null)}
          onChanged={() => router.refresh()}
        />
      ) : null}

      {newShiftDate ? (
        <NewShiftDialog
          locationId={locationId}
          timezone={timezone}
          date={newShiftDate}
          skills={skills}
          onClose={() => setNewShiftDate(null)}
        />
      ) : null}
    </>
  );
}

function ShiftCard({
  shift,
  timezone,
  onOpen,
}: {
  shift: ShiftView;
  timezone: string;
  onOpen: () => void;
}) {
  const start = DateTime.fromISO(shift.startsAt, { zone: timezone });
  const end = DateTime.fromISO(shift.endsAt, { zone: timezone });
  const overnight = !start.hasSame(end, "day");

  const filled = shift.assignments.length;
  const understaffed = filled < shift.headcount;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full text-left rounded-md border px-2 py-1.5 hover:border-[var(--accent)] transition-colors"
      style={{
        borderColor: understaffed ? "var(--block)" : "var(--border)",
        background: shift.isPremium ? "var(--premium-soft)" : "var(--surface-raised)",
        opacity: shift.isPublished ? 1 : 0.72,
      }}
    >
      <div className="flex items-center justify-between gap-1">
        <span className="text-xs font-semibold tnum">
          {start.toFormat("HH:mm")}–{end.toFormat("HH:mm")}
          {overnight ? <span className="text-[var(--text-subtle)] font-normal"> +1</span> : null}
        </span>
        <span
          className="text-[10px] font-bold tnum"
          style={{ color: understaffed ? "var(--block)" : "var(--text-subtle)" }}
        >
          {filled}/{shift.headcount}
        </span>
      </div>

      <div className="text-[11px] text-[var(--text-muted)] mt-0.5 flex items-center gap-1 flex-wrap">
        <span>{shift.skillName}</span>
        {shift.isPremium ? (
          <span className="badge" style={{ background: "var(--premium)", color: "#fff" }}>
            Premium
          </span>
        ) : null}
        {!shift.isPublished ? (
          <span
            className="badge"
            style={{ background: "var(--surface-sunken)", color: "var(--text-subtle)" }}
          >
            Draft
          </span>
        ) : null}
      </div>

      {shift.assignments.length > 0 ? (
        <ul className="mt-1 space-y-0.5">
          {shift.assignments.map((a) => (
            <li key={a.id} className="text-[11px] truncate">
              {a.fullName}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-[11px] font-medium" style={{ color: "var(--block)" }}>
          Unstaffed
        </p>
      )}
    </button>
  );
}
