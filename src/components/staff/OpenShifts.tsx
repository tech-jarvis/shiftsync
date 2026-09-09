"use client";

import { DateTime } from "luxon";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { pickUpOpenShift, pickUpShift } from "@/app/(app)/staff/actions";
import { ViolationList } from "@/components/ViolationList";
import { createClient } from "@/lib/supabase/browser";
import type { Violation } from "@/rules/types";

export interface OpenShiftView {
  shiftId: string;
  /** Set when this shift is available because a colleague offered it up. */
  requestId: string | null;
  startsAt: string;
  endsAt: string;
  locationName: string;
  locationTimezone: string;
  skillName: string;
  isPremium: boolean;
  warnings: Violation[];
  weeklyHoursAfter: number;
}

export function OpenShifts({
  shifts,
  profileId,
}: {
  shifts: OpenShiftView[];
  profileId: string;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`open-shifts:${profileId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "swap_requests" }, () =>
        router.refresh(),
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "assignments" }, () =>
        router.refresh(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [profileId, router]);

  const take = (shift: OpenShiftView) =>
    startTransition(async () => {
      if (shift.requestId) {
        const outcome = await pickUpShift(shift.requestId);
        setMessage({
          text:
            outcome.status === "updated"
              ? "Claimed. Your manager needs to approve it before the shift is yours."
              : "reason" in outcome
                ? outcome.reason
                : "Could not claim that shift.",
          ok: outcome.status === "updated",
        });
      } else {
        const outcome = await pickUpOpenShift(shift.shiftId);
        setMessage({
          text:
            outcome.status === "assigned"
              ? "Picked up. It is on your schedule now."
              : outcome.status === "rejected" || outcome.status === "conflict"
                ? outcome.violations[0]?.message ?? "Could not pick up that shift."
                : "Could not pick up that shift.",
          ok: outcome.status === "assigned",
        });
      }
      router.refresh();
    });

  if (shifts.length === 0) {
    return (
      <p className="text-sm text-[var(--text-subtle)]">
        Nothing available to pick up right now.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {message ? (
        <p
          className="card p-3 text-sm"
          style={{
            borderColor: message.ok ? "var(--ok)" : "var(--block)",
            background: message.ok ? "var(--ok-soft)" : "var(--block-soft)",
          }}
          role="status"
        >
          {message.text}
        </p>
      ) : null}

      <ul className="space-y-2">
        {shifts.map((shift) => {
          const start = DateTime.fromISO(shift.startsAt, { zone: shift.locationTimezone });
          const end = DateTime.fromISO(shift.endsAt, { zone: shift.locationTimezone });
          const overnight = !start.hasSame(end, "day");
          const hours = Math.round(end.diff(start, "hours").hours * 10) / 10;

          return (
            <li key={`${shift.shiftId}-${shift.requestId ?? "open"}`} className="card p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold tnum">
                      {start.toFormat("EEE d LLL")} · {start.toFormat("HH:mm")}–
                      {end.toFormat("HH:mm")}
                      {overnight ? " (+1)" : ""}
                    </span>
                    <span className="text-[11px] text-[var(--text-subtle)]">
                      {start.toFormat("ZZZZ")}
                    </span>
                    {shift.requestId ? (
                      <span
                        className="badge"
                        style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
                      >
                        Offered up
                      </span>
                    ) : null}
                  </div>
                  <div className="text-xs text-[var(--text-muted)] mt-0.5 tnum">
                    {shift.locationName} · {shift.skillName} · {hours}h · would take you to{" "}
                    {shift.weeklyHoursAfter}h this week
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => take(shift)}
                  disabled={pending}
                  className="btn btn-primary text-xs shrink-0"
                >
                  {shift.requestId ? "Claim" : "Pick up"}
                </button>
              </div>

              {shift.warnings.length > 0 ? (
                <div className="mt-2">
                  <ViolationList violations={shift.warnings} compact />
                </div>
              ) : null}

              {shift.requestId ? (
                <p className="text-[11px] text-[var(--text-subtle)] mt-2">
                  Claiming sends this to a manager for approval.
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
