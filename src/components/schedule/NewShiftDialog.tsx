"use client";

import { DateTime } from "luxon";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createShiftAction } from "@/app/(app)/schedule/actions";
import { useOverlay } from "@/lib/useOverlay";

export interface SkillOption {
  id: string;
  name: string;
}

export function NewShiftDialog({
  locationId,
  timezone,
  date,
  skills,
  onClose,
}: {
  locationId: string;
  timezone: string;
  /** Local date 'YYYY-MM-DD' in the location's zone. */
  date: string;
  skills: SkillOption[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useOverlay(onClose);

  const [skillId, setSkillId] = useState(skills[0]?.id ?? "");
  const [startTime, setStartTime] = useState("17:00");
  const [endTime, setEndTime] = useState("23:00");
  const [headcount, setHeadcount] = useState(1);

  const overnight = endTime <= startTime;

  const submit = () =>
    startTransition(async () => {
      setError(null);
      const result = await createShiftAction({
        locationId,
        skillId,
        date,
        startTime,
        endTime,
        headcount,
      });
      if (!result.ok) setError(result.error ?? "Could not create that shift.");
      else {
        router.refresh();
        onClose();
      }
    });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Click-catcher, not a control: a screen-sized "Close" button is noise
          to a screen reader. Escape and Cancel are the keyboard routes out. */}
      <div aria-hidden="true" className="absolute inset-0 bg-black/40" onClick={onClose} />

      <div
        ref={dialogRef as React.RefObject<HTMLDivElement>}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-shift-title"
        tabIndex={-1}
        className="relative card w-full max-w-sm p-4 shadow-2xl outline-none"
        style={{ background: "var(--surface)" }}
      >
        <h2 id="new-shift-title" className="text-sm font-semibold">
          New shift · {DateTime.fromISO(date, { zone: timezone }).toFormat("EEE d LLL")}
        </h2>
        <p className="text-xs text-[var(--text-muted)] mt-0.5 mb-3">
          Times are local to this location ({DateTime.fromISO(date, { zone: timezone }).toFormat("ZZZZ")}).
          Created as a draft — staff see it once you publish.
        </p>

        {error ? (
          <p
            role="alert"
            className="text-xs rounded-md px-2.5 py-2 mb-3 border"
            style={{ color: "var(--block)", background: "var(--block-soft)", borderColor: "var(--block)" }}
          >
            {error}
          </p>
        ) : null}

        <div className="space-y-3">
          <label className="block text-xs">
            <span className="block text-[var(--text-muted)] mb-1">Required skill</span>
            <select value={skillId} onChange={(e) => setSkillId(e.target.value)} className="field text-sm">
              {skills.map((skill) => (
                <option key={skill.id} value={skill.id}>
                  {skill.name}
                </option>
              ))}
            </select>
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs">
              <span className="block text-[var(--text-muted)] mb-1">Start</span>
              <input
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="field text-sm"
              />
            </label>
            <label className="block text-xs">
              <span className="block text-[var(--text-muted)] mb-1">End</span>
              <input
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className="field text-sm"
              />
            </label>
          </div>

          {overnight ? (
            <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              Ends after midnight — this will be saved as one overnight shift finishing the next
              day.
            </p>
          ) : null}

          <label className="block text-xs">
            <span className="block text-[var(--text-muted)] mb-1">People needed</span>
            <input
              type="number"
              min={1}
              max={20}
              value={headcount}
              onChange={(e) => setHeadcount(Number(e.target.value))}
              className="field text-sm w-24"
            />
          </label>
        </div>

        <div className="flex gap-2 mt-4">
          <button
            type="button"
            onClick={submit}
            disabled={pending || !skillId}
            className="btn btn-primary text-xs"
          >
            {pending ? "Creating\u2026" : "Create shift"}
          </button>
          <button type="button" onClick={onClose} className="btn text-xs">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
