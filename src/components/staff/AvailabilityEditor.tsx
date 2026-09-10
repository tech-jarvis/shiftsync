"use client";

import { DateTime } from "luxon";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  addAvailabilityException,
  addAvailabilityRule,
  removeAvailabilityException,
  removeAvailabilityRule,
} from "@/app/(app)/staff/actions";

export interface RuleRow {
  id: string;
  isoWeekday: number;
  startMinute: number;
  endMinute: number;
}

export interface ExceptionRow {
  id: string;
  date: string;
  isAvailable: boolean;
  startMinute: number | null;
  endMinute: number | null;
  reason: string | null;
}

const DAYS = [
  { iso: 1, label: "Monday" },
  { iso: 2, label: "Tuesday" },
  { iso: 3, label: "Wednesday" },
  { iso: 4, label: "Thursday" },
  { iso: 5, label: "Friday" },
  { iso: 6, label: "Saturday" },
  { iso: 7, label: "Sunday" },
];

/** Minutes from local midnight -> "HH:mm", with "+1" past midnight. */
function minutesToLabel(minute: number): string {
  const day = Math.floor(minute / 1440);
  const within = minute % 1440;
  const text = `${String(Math.floor(within / 60)).padStart(2, "0")}:${String(within % 60).padStart(2, "0")}`;
  return day > 0 ? `${text} (+${day})` : text;
}

function toMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

export function AvailabilityEditor({
  rules,
  exceptions,
  timezone,
}: {
  rules: RuleRow[];
  exceptions: ExceptionRow[];
  timezone: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [day, setDay] = useState(1);
  const [from, setFrom] = useState("09:00");
  const [to, setTo] = useState("17:00");
  const [pastMidnight, setPastMidnight] = useState(false);

  const [exceptionDate, setExceptionDate] = useState(
    DateTime.now().setZone(timezone).plus({ days: 1 }).toFormat("yyyy-MM-dd"),
  );
  const [exceptionKind, setExceptionKind] = useState<"off" | "extra">("off");
  const [exceptionFrom, setExceptionFrom] = useState("18:00");
  const [exceptionTo, setExceptionTo] = useState("23:00");
  const [exceptionReason, setExceptionReason] = useState("");

  const addRule = () =>
    startTransition(async () => {
      setError(null);
      const start = toMinutes(from);
      const end = toMinutes(to) + (pastMidnight ? 1440 : 0);
      const result = await addAvailabilityRule(day, start, end);
      if (!result.ok) setError(result.error ?? "Could not add that window.");
      else router.refresh();
    });

  const addException = () =>
    startTransition(async () => {
      setError(null);
      const result = await addAvailabilityException(
        exceptionDate,
        exceptionKind === "extra",
        exceptionKind === "extra" ? toMinutes(exceptionFrom) : null,
        exceptionKind === "extra" ? toMinutes(exceptionTo) : null,
        exceptionReason || null,
      );
      if (!result.ok) setError(result.error ?? "Could not save that.");
      else {
        setExceptionReason("");
        router.refresh();
      }
    });

  return (
    <div className="space-y-5">
      {error ? (
        <p
          className="card p-3 text-sm"
          style={{ borderColor: "var(--block)", background: "var(--block-soft)" }}
        >
          {error}
        </p>
      ) : null}

      <section className="card p-4">
        <h2 className="text-sm font-semibold mb-1">Every week</h2>
        <p className="text-xs text-[var(--text-muted)] mb-3">
          Your usual hours. A window can run past midnight — tick the box and the end time is
          read as the next day.
        </p>

        <div className="space-y-2 mb-4">
          {DAYS.map((weekday) => {
            const forDay = rules.filter((r) => r.isoWeekday === weekday.iso);
            return (
              <div key={weekday.iso} className="flex items-center gap-2 flex-wrap">
                <span className="text-xs w-20 shrink-0 text-[var(--text-muted)]">
                  {weekday.label}
                </span>
                {forDay.length === 0 ? (
                  <span className="text-xs text-[var(--text-subtle)]">Not available</span>
                ) : (
                  forDay.map((rule) => (
                    <span
                      key={rule.id}
                      className="badge tnum"
                      style={{ background: "var(--ok-soft)", color: "var(--ok)" }}
                    >
                      {minutesToLabel(rule.startMinute)}–{minutesToLabel(rule.endMinute)}
                      {/* A 20px box around a 10px glyph: this is a phone
                          target, and the badge text is not the thing to hit. */}
                      <button
                        type="button"
                        onClick={() =>
                          startTransition(async () => {
                            await removeAvailabilityRule(rule.id);
                            router.refresh();
                          })
                        }
                        disabled={pending}
                        aria-label={`Remove ${weekday.label} ${minutesToLabel(rule.startMinute)}`}
                        className="tap -mr-1 ml-0.5 opacity-60 hover:opacity-100"
                      >
                        ×
                      </button>
                    </span>
                  ))
                )}
              </div>
            );
          })}
        </div>

        <div
          className="flex flex-wrap items-end gap-2 pt-3 border-t"
          style={{ borderColor: "var(--border)" }}
        >
          <label className="text-xs">
            <span className="block text-[var(--text-muted)] mb-1">Day</span>
            <select
              value={day}
              onChange={(e) => setDay(Number(e.target.value))}
              className="field text-xs w-32"
            >
              {DAYS.map((d) => (
                <option key={d.iso} value={d.iso}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs">
            <span className="block text-[var(--text-muted)] mb-1">From</span>
            <input
              type="time"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="field text-xs w-28"
            />
          </label>
          <label className="text-xs">
            <span className="block text-[var(--text-muted)] mb-1">To</span>
            <input
              type="time"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="field text-xs w-28"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs pb-2">
            <input
              type="checkbox"
              checked={pastMidnight}
              onChange={(e) => setPastMidnight(e.target.checked)}
            />
            Ends next day
          </label>
          <button type="button" onClick={addRule} disabled={pending} className="btn text-xs">
            {pending ? "Adding\u2026" : "Add window"}
          </button>
        </div>
      </section>

      <section className="card p-4">
        <h2 className="text-sm font-semibold mb-1">One-off changes</h2>
        <p className="text-xs text-[var(--text-muted)] mb-3">
          A specific date where your usual hours do not apply. These always win over your weekly
          pattern.
        </p>

        {exceptions.length > 0 ? (
          <ul className="space-y-1.5 mb-4">
            {exceptions.map((exception) => (
              <li
                key={exception.id}
                className="flex items-center justify-between gap-2 text-xs rounded-md px-2 py-1.5"
                style={{
                  background: exception.isAvailable ? "var(--ok-soft)" : "var(--block-soft)",
                }}
              >
                <span className="tnum">
                  <strong>
                    {DateTime.fromISO(exception.date, { zone: timezone }).toFormat("EEE d LLL")}
                  </strong>{" "}
                  ·{" "}
                  {exception.isAvailable
                    ? `available ${minutesToLabel(exception.startMinute ?? 0)}–${minutesToLabel(exception.endMinute ?? 0)}`
                    : exception.startMinute === null
                      ? "unavailable all day"
                      : `unavailable ${minutesToLabel(exception.startMinute)}–${minutesToLabel(exception.endMinute ?? 0)}`}
                  {exception.reason ? (
                    <span className="text-[var(--text-muted)]"> — {exception.reason}</span>
                  ) : null}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    startTransition(async () => {
                      await removeAvailabilityException(exception.id);
                      router.refresh();
                    })
                  }
                  disabled={pending}
                  className="tap opacity-60 hover:opacity-100 shrink-0"
                  aria-label={`Remove exception on ${exception.date}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <div
          className="flex flex-wrap items-end gap-2 pt-3 border-t"
          style={{ borderColor: "var(--border)" }}
        >
          <label className="text-xs">
            <span className="block text-[var(--text-muted)] mb-1">Date</span>
            <input
              type="date"
              value={exceptionDate}
              onChange={(e) => setExceptionDate(e.target.value)}
              className="field text-xs w-36"
            />
          </label>
          <label className="text-xs">
            <span className="block text-[var(--text-muted)] mb-1">Change</span>
            <select
              value={exceptionKind}
              onChange={(e) => setExceptionKind(e.target.value as "off" | "extra")}
              className="field text-xs w-40"
            >
              <option value="off">Unavailable all day</option>
              <option value="extra">Extra availability</option>
            </select>
          </label>
          {exceptionKind === "extra" ? (
            <>
              <label className="text-xs">
                <span className="block text-[var(--text-muted)] mb-1">From</span>
                <input
                  type="time"
                  value={exceptionFrom}
                  onChange={(e) => setExceptionFrom(e.target.value)}
                  className="field text-xs w-28"
                />
              </label>
              <label className="text-xs">
                <span className="block text-[var(--text-muted)] mb-1">To</span>
                <input
                  type="time"
                  value={exceptionTo}
                  onChange={(e) => setExceptionTo(e.target.value)}
                  className="field text-xs w-28"
                />
              </label>
            </>
          ) : null}
          <label className="text-xs flex-1 min-w-[10rem]">
            <span className="block text-[var(--text-muted)] mb-1">Reason (optional)</span>
            <input
              type="text"
              value={exceptionReason}
              onChange={(e) => setExceptionReason(e.target.value)}
              className="field text-xs"
              placeholder="e.g. Dentist"
            />
          </label>
          <button type="button" onClick={addException} disabled={pending} className="btn text-xs">
            {pending ? "Saving\u2026" : "Save"}
          </button>
        </div>
      </section>
    </div>
  );
}
