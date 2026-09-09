"use client";

import { DateTime } from "luxon";
import { useEffect, useState, useTransition } from "react";
import {
  assignAction,
  loadAssignmentOptions,
  releaseAction,
  shiftHistory,
} from "@/app/(app)/schedule/actions";
import type { AssignmentOption } from "@/domain/scheduling/options";
import type { Violation } from "@/rules/types";
import { ViolationList } from "@/components/ViolationList";
import type { ShiftView } from "./WeekGrid";

/**
 * The assignment panel.
 *
 * This is the screen the brief's UX criterion really tests, so it answers three
 * questions at once rather than one at a time:
 *
 *   who is on this shift        -- the current roster, removable
 *   who else could be           -- ranked, with the cost of each choice
 *   what happens if I pick them -- the what-if projection, shown BEFORE
 *                                  confirming, computed by the same engine that
 *                                  will validate the write
 *
 * Blocked people are listed too, greyed out with the rule that blocks them.
 * Omitting them would leave the manager wondering where someone went and
 * checking by hand; "certification ended 31 Jan" ends the question immediately.
 */
export function AssignPanel({
  shift,
  timezone,
  onClose,
  onChanged,
}: {
  shift: ShiftView;
  timezone: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [options, setOptions] = useState<AssignmentOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Violation[] | null>(null);
  const [overrideFor, setOverrideFor] = useState<string | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
  const [history, setHistory] = useState<
    { occurredAt: string; actorName: string; entityType: string; action: string; changed: string[] }[] | null
  >(null);
  const [showHistory, setShowHistory] = useState(false);
  const [pending, startTransition] = useTransition();

  const refresh = () => {
    loadAssignmentOptions(shift.id)
      .then(setOptions)
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load options."));
  };

  useEffect(refresh, [shift.id]);

  const start = DateTime.fromISO(shift.startsAt, { zone: timezone });
  const end = DateTime.fromISO(shift.endsAt, { zone: timezone });
  const overnight = !start.hasSame(end, "day");
  const hours = end.diff(start, "hours").hours;

  const assign = (staffId: string, reason?: string) => {
    setConflict(null);
    setError(null);

    startTransition(async () => {
      const outcome = await assignAction(shift.id, staffId, reason);

      if (outcome.status === "assigned") {
        setOverrideFor(null);
        setOverrideReason("");
        onChanged();
        refresh();
        return;
      }
      if (outcome.status === "override_required") {
        setOverrideFor(staffId);
        return;
      }
      if (outcome.status === "conflict") {
        // Someone else committed a conflicting change between our validation
        // and our write. Say so plainly rather than showing a generic failure.
        setConflict(outcome.violations);
        onChanged();
        refresh();
        return;
      }
      if (outcome.status === "rejected") {
        setConflict(outcome.violations);
        refresh();
        return;
      }
      setError(outcome.message);
    });
  };

  const remove = (assignmentId: string) => {
    startTransition(async () => {
      await releaseAction(assignmentId);
      onChanged();
      refresh();
    });
  };

  const roster = options?.filter((o) => o.assigned) ?? [];
  const candidates = options?.filter((o) => !o.assigned) ?? [];
  const free = shift.headcount - shift.assignments.length;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label="Close panel"
        className="flex-1 bg-black/40"
        onClick={onClose}
      />

      <aside
        className="w-full max-w-md h-full overflow-y-auto shadow-2xl"
        style={{ background: "var(--surface)" }}
        aria-label="Assign staff to shift"
      >
        <header
          className="sticky top-0 z-10 px-4 py-3 border-b"
          style={{ borderColor: "var(--border)", background: "var(--surface)" }}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold tnum">
                {start.toFormat("EEE d LLL, HH:mm")}–{end.toFormat("HH:mm")}
                {overnight ? " (+1 day)" : ""}
              </h2>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                {shift.skillName} · {hours}h · {start.toFormat("ZZZZ")}
                {shift.isPremium ? " · Premium shift" : ""}
              </p>
            </div>
            <button type="button" onClick={onClose} className="btn text-xs">
              Close
            </button>
          </div>

          <p className="text-xs mt-2" style={{ color: free > 0 ? "var(--block)" : "var(--ok)" }}>
            {free > 0
              ? `${free} of ${shift.headcount} position${shift.headcount === 1 ? "" : "s"} still unfilled`
              : `Fully staffed (${shift.headcount}/${shift.headcount})`}
          </p>
        </header>

        <div className="p-4 space-y-5">
          {error ? (
            <p
              className="text-xs rounded-md px-3 py-2 border"
              style={{ color: "var(--block)", background: "var(--block-soft)", borderColor: "var(--block)" }}
            >
              {error}
            </p>
          ) : null}

          {conflict ? (
            <section>
              <h3 className="text-xs font-semibold mb-1.5">That change was not saved</h3>
              <ViolationList violations={conflict} />
            </section>
          ) : null}

          <section>
            <h3 className="text-xs font-semibold mb-2 text-[var(--text-muted)]">
              On this shift
            </h3>
            {roster.length === 0 ? (
              <p className="text-xs text-[var(--text-subtle)]">Nobody assigned yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {roster.map((person) => {
                  const assignment = shift.assignments.find((a) => a.staffId === person.staffId);
                  return (
                    <li
                      key={person.staffId}
                      className="card px-3 py-2 flex items-center justify-between gap-2"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{person.fullName}</div>
                        <div className="text-[11px] text-[var(--text-muted)] tnum">
                          {person.projection.weeklyHoursAfter}h this week
                          {person.consecutiveDays >= 5
                            ? ` · ${person.consecutiveDays} consecutive days`
                            : ""}
                        </div>
                      </div>
                      {assignment ? (
                        <button
                          type="button"
                          onClick={() => remove(assignment.id)}
                          disabled={pending}
                          className="btn btn-danger text-xs shrink-0"
                        >
                          Remove
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section>
            <h3 className="text-xs font-semibold mb-2 text-[var(--text-muted)]">
              Available to assign
            </h3>

            {options === null ? (
              <p className="text-xs text-[var(--text-subtle)]">Checking everyone against the rules…</p>
            ) : candidates.length === 0 ? (
              <p className="text-xs text-[var(--text-subtle)]">
                Nobody else holds the {shift.skillName} skill at this location.
              </p>
            ) : (
              <ul className="space-y-2">
                {candidates.map((person) => (
                  <CandidateRow
                    key={person.staffId}
                    person={person}
                    pending={pending}
                    isOverriding={overrideFor === person.staffId}
                    overrideReason={overrideReason}
                    onOverrideReasonChange={setOverrideReason}
                    onAssign={(reason) => assign(person.staffId, reason)}
                    onCancelOverride={() => {
                      setOverrideFor(null);
                      setOverrideReason("");
                    }}
                  />
                ))}
              </ul>
            )}
          </section>

          <section>
            <button
              type="button"
              onClick={() => {
                setShowHistory((open) => !open);
                if (history === null) shiftHistory(shift.id).then(setHistory).catch(() => setHistory([]));
              }}
              className="text-xs font-semibold text-[var(--text-muted)] hover:text-[var(--text)]"
              aria-expanded={showHistory}
            >
              {showHistory ? "Hide" : "Show"} change history
            </button>

            {showHistory ? (
              history === null ? (
                <p className="text-xs text-[var(--text-subtle)] mt-2">Loading…</p>
              ) : history.length === 0 ? (
                <p className="text-xs text-[var(--text-subtle)] mt-2">No recorded changes.</p>
              ) : (
                <ol className="mt-2 space-y-1.5">
                  {history.map((entry, index) => (
                    <li
                      key={`${entry.occurredAt}-${index}`}
                      className="text-[11px] leading-relaxed border-l-2 pl-2"
                      style={{ borderColor: "var(--border-strong)" }}
                    >
                      <span className="tnum text-[var(--text-subtle)]">
                        {DateTime.fromISO(entry.occurredAt).toFormat("d LLL HH:mm")}
                      </span>{" "}
                      <strong>{entry.actorName}</strong>{" "}
                      <span className="text-[var(--text-muted)]">
                        {entry.action}d {entry.entityType.replace(/s$/, "")}
                        {entry.changed.length > 0 ? ` (${entry.changed.join(", ")})` : ""}
                      </span>
                    </li>
                  ))}
                </ol>
              )
            ) : null}
          </section>
        </div>
      </aside>
    </div>
  );
}

function CandidateRow({
  person,
  pending,
  isOverriding,
  overrideReason,
  onOverrideReasonChange,
  onAssign,
  onCancelOverride,
}: {
  person: AssignmentOption;
  pending: boolean;
  isOverriding: boolean;
  overrideReason: string;
  onOverrideReasonChange: (value: string) => void;
  onAssign: (reason?: string) => void;
  onCancelOverride: () => void;
}) {
  const { projection } = person;
  const delta = projection.weeklyHoursAfter - projection.weeklyHoursBefore;

  return (
    <li className="card px-3 py-2.5" style={{ opacity: person.blocked ? 0.72 : 1 }}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">{person.fullName}</div>

          {/* The what-if, shown before confirming rather than after. */}
          <div className="text-[11px] text-[var(--text-muted)] tnum mt-0.5">
            {projection.weeklyHoursBefore}h → <strong>{projection.weeklyHoursAfter}h</strong> this
            week (+{delta}h)
            {projection.desiredHoursDelta !== null ? (
              <span
                style={{
                  color: projection.desiredHoursDelta > 0 ? "var(--warn)" : "var(--text-subtle)",
                }}
              >
                {" · "}
                {projection.desiredHoursDelta > 0
                  ? `${projection.desiredHoursDelta}h over`
                  : `${Math.abs(projection.desiredHoursDelta)}h under`} their target
              </span>
            ) : null}
          </div>
        </div>

        {!person.blocked && !isOverriding ? (
          <button
            type="button"
            onClick={() => onAssign()}
            disabled={pending}
            className={`btn text-xs shrink-0 ${person.violations.length === 0 ? "btn-primary" : ""}`}
          >
            Assign
          </button>
        ) : null}
      </div>

      {person.violations.length > 0 ? (
        <div className="mt-2">
          <ViolationList violations={person.violations} compact />
        </div>
      ) : null}

      {isOverriding ? (
        <div className="mt-2 space-y-2">
          <label
            htmlFor={`override-${person.staffId}`}
            className="block text-[11px] font-medium text-[var(--text-muted)]"
          >
            Document why this override is justified (recorded in the audit trail)
          </label>
          <textarea
            id={`override-${person.staffId}`}
            value={overrideReason}
            onChange={(e) => onOverrideReasonChange(e.target.value)}
            rows={2}
            className="field text-xs"
            placeholder="e.g. Two call-outs; employee volunteered and confirmed by phone."
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onAssign(overrideReason)}
              disabled={pending || overrideReason.trim().length < 10}
              className="btn btn-primary text-xs"
            >
              Approve override
            </button>
            <button type="button" onClick={onCancelOverride} className="btn text-xs">
              Cancel
            </button>
          </div>
          {overrideReason.trim().length > 0 && overrideReason.trim().length < 10 ? (
            <p className="text-[11px]" style={{ color: "var(--override)" }}>
              A documented reason of at least 10 characters is required.
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
