"use client";

import { DateTime } from "luxon";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import {
  answerSwap,
  askColleagueToCover,
  cancelMyRequest,
  coverCandidates,
  offerShiftUp,
} from "@/app/(app)/staff/actions";
import { createClient } from "@/lib/supabase/browser";

export interface MyShiftView {
  assignmentId: string;
  shiftId: string;
  startsAt: string;
  endsAt: string;
  locationName: string;
  locationTimezone: string;
  skillName: string;
  isPremium: boolean;
}

export interface PendingRequestView {
  id: string;
  kind: "swap" | "drop";
  state: string;
  mine: boolean;
  requesterName: string;
  startsAt: string;
  endsAt: string;
  locationName: string;
  locationTimezone: string;
}

function formatShift(startsAt: string, endsAt: string, zone: string) {
  const start = DateTime.fromISO(startsAt, { zone });
  const end = DateTime.fromISO(endsAt, { zone });
  const overnight = !start.hasSame(end, "day");
  return {
    day: start.toFormat("EEE d LLL"),
    time: `${start.toFormat("HH:mm")}–${end.toFormat("HH:mm")}${overnight ? " (+1)" : ""}`,
    zone: start.toFormat("ZZZZ"),
    hours: Math.round(end.diff(start, "hours").hours * 10) / 10,
  };
}

export function MyShifts({
  shifts,
  requests,
  profileId,
}: {
  shifts: MyShiftView[];
  requests: PendingRequestView[];
  profileId: string;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  // Live: a manager publishing, approving a swap, or moving a shift updates
  // this list without a refresh.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`my-shifts:${profileId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "assignments" }, () =>
        router.refresh(),
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "swap_requests" }, () =>
        router.refresh(),
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [profileId, router]);

  const incoming = requests.filter((r) => !r.mine && r.state === "pending_target");
  const mine = requests.filter((r) => r.mine);

  return (
    <div className="space-y-5">
      {message ? (
        <div
          className="card p-3 text-sm flex items-start gap-2"
          style={{
            borderColor: message.ok ? "var(--ok)" : "var(--block)",
            background: message.ok ? "var(--ok-soft)" : "var(--block-soft)",
          }}
          role="status"
        >
          <span className="flex-1">{message.text}</span>
          <button
            type="button"
            onClick={() => setMessage(null)}
            aria-label="Dismiss message"
            className="tap shrink-0 opacity-60 hover:opacity-100"
          >
            &times;
          </button>
        </div>
      ) : null}

      {incoming.length > 0 ? (
        <section>
          <h2 className="text-xs font-semibold mb-2 text-[var(--text-muted)]">
            Waiting on you
          </h2>
          <ul className="space-y-2">
            {incoming.map((request) => (
              <IncomingRequest
                key={request.id}
                request={request}
                onDone={(text, ok) => {
                  setMessage({ text, ok });
                  router.refresh();
                }}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {mine.length > 0 ? (
        <section>
          <h2 className="text-xs font-semibold mb-2 text-[var(--text-muted)]">
            Your open requests
          </h2>
          <ul className="space-y-2">
            {mine.map((request) => (
              <MyRequest
                key={request.id}
                request={request}
                onDone={(text, ok) => {
                  setMessage({ text, ok });
                  router.refresh();
                }}
              />
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h2 className="text-xs font-semibold mb-2 text-[var(--text-muted)]">Upcoming</h2>
        {shifts.length === 0 ? (
          <div className="card px-4 py-6 text-center">
            <p className="text-sm font-medium">No upcoming shifts</p>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              Once your manager publishes the schedule, your shifts appear here. In the meantime you
              can pick up open shifts or update when you&rsquo;re available.
            </p>
            <div className="flex justify-center gap-2 mt-3">
              <a href="/staff/open" className="btn text-xs">Browse open shifts</a>
              <a href="/staff/availability" className="btn text-xs">Set availability</a>
            </div>
          </div>
        ) : (
          <ul className="space-y-2">
            {shifts.map((shift) => (
              <ShiftRow
                key={shift.assignmentId}
                shift={shift}
                onDone={(text, ok) => {
                  setMessage({ text, ok });
                  router.refresh();
                }}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ShiftRow({
  shift,
  onDone,
}: {
  shift: MyShiftView;
  onDone: (text: string, ok: boolean) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [asking, setAsking] = useState(false);
  const [candidates, setCandidates] = useState<{ id: string; fullName: string }[] | null>(null);
  const format = formatShift(shift.startsAt, shift.endsAt, shift.locationTimezone);

  const openAsk = () => {
    setAsking(true);
    coverCandidates(shift.assignmentId).then(setCandidates).catch(() => setCandidates([]));
  };

  const offerUp = () =>
    startTransition(async () => {
      const outcome = await offerShiftUp(shift.assignmentId);
      onDone(
        outcome.status === "created"
          ? "Offered up. Qualified colleagues have been notified — you remain scheduled until a manager approves a replacement."
          : "reason" in outcome
            ? outcome.reason
            : "Could not offer this shift up.",
        outcome.status === "created",
      );
    });

  const ask = (targetStaffId: string) =>
    startTransition(async () => {
      const outcome = await askColleagueToCover(shift.assignmentId, targetStaffId);
      setAsking(false);
      onDone(
        outcome.status === "created"
          ? "Request sent. You remain scheduled until they accept and a manager approves."
          : "reason" in outcome
            ? outcome.reason
            : "Could not send that request.",
        outcome.status === "created",
      );
    });

  return (
    <li className="card p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold tnum">{format.day}</span>
            <span className="text-sm tnum">{format.time}</span>
            <span className="text-[11px] text-[var(--text-subtle)]">{format.zone}</span>
            {shift.isPremium ? (
              <span className="badge" style={{ background: "var(--premium)", color: "#fff" }}>
                Premium
              </span>
            ) : null}
          </div>
          <div className="text-xs text-[var(--text-muted)] mt-0.5">
            {shift.locationName} · {shift.skillName} · {format.hours}h
          </div>
        </div>

        <div className="flex gap-1.5 shrink-0">
          <button type="button" onClick={openAsk} disabled={pending} className="btn text-xs">
            Ask someone
          </button>
          <button type="button" onClick={offerUp} disabled={pending} className="btn text-xs">
            {pending ? "Working\u2026" : "Offer up"}
          </button>
        </div>
      </div>

      {asking ? (
        <div className="mt-3 pt-3 border-t" style={{ borderColor: "var(--border)" }}>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium">Who should cover this?</span>
            <button type="button" onClick={() => setAsking(false)} className="text-xs text-[var(--text-muted)]">
              Cancel
            </button>
          </div>
          {candidates === null ? (
            <p className="text-xs text-[var(--text-subtle)]">Finding qualified colleagues…</p>
          ) : candidates.length === 0 ? (
            <p className="text-xs text-[var(--text-subtle)]">
              Nobody else is certified and skilled for this shift. Try &ldquo;Offer up&rdquo; instead.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {candidates.map((person) => (
                <li key={person.id}>
                  <button
                    type="button"
                    onClick={() => ask(person.id)}
                    disabled={pending}
                    className="btn text-xs"
                  >
                    {person.fullName}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </li>
  );
}

function IncomingRequest({
  request,
  onDone,
}: {
  request: PendingRequestView;
  onDone: (text: string, ok: boolean) => void;
}) {
  const [pending, startTransition] = useTransition();
  const format = formatShift(request.startsAt, request.endsAt, request.locationTimezone);

  const answer = (accept: boolean) =>
    startTransition(async () => {
      const outcome = await answerSwap(request.id, accept);
      onDone(
        outcome.status === "updated"
          ? accept
            ? "Accepted. It now needs manager approval — nothing changes until then."
            : "Declined."
          : "reason" in outcome
            ? outcome.reason
            : "Could not respond.",
        outcome.status === "updated",
      );
    });

  return (
    <li className="card p-3" style={{ borderColor: "var(--accent)" }}>
      <p className="text-sm">
        <strong>{request.requesterName}</strong> asked you to cover{" "}
        <span className="tnum">
          {format.day}, {format.time}
        </span>{" "}
        at {request.locationName}.
      </p>
      <div className="flex gap-2 mt-2">
        <button
          type="button"
          onClick={() => answer(true)}
          disabled={pending}
          className="btn btn-primary text-xs"
        >
          Accept
        </button>
        <button type="button" onClick={() => answer(false)} disabled={pending} className="btn text-xs">
          Decline
        </button>
      </div>
    </li>
  );
}

function MyRequest({
  request,
  onDone,
}: {
  request: PendingRequestView;
  onDone: (text: string, ok: boolean) => void;
}) {
  const [pending, startTransition] = useTransition();
  const format = formatShift(request.startsAt, request.endsAt, request.locationTimezone);

  const STATE_LABEL: Record<string, string> = {
    pending_target: "Waiting for them to accept",
    open: "Open for anyone qualified to claim",
    pending_manager: "Waiting for manager approval",
  };

  const withdraw = () =>
    startTransition(async () => {
      const outcome = await cancelMyRequest(request.id);
      onDone(
        outcome.status === "updated"
          ? "Withdrawn. You are still scheduled for this shift."
          : "reason" in outcome
            ? outcome.reason
            : "Could not withdraw.",
        outcome.status === "updated",
      );
    });

  return (
    <li className="card p-3 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm tnum">
          {request.kind === "drop" ? "Offered up" : "Swap"} · {format.day}, {format.time}
        </p>
        <p className="text-xs text-[var(--text-muted)] mt-0.5">
          {request.locationName} · {STATE_LABEL[request.state] ?? request.state}
        </p>
        <p className="text-xs text-[var(--text-subtle)] mt-0.5">
          You remain scheduled until a manager approves.
        </p>
      </div>
      <button type="button" onClick={withdraw} disabled={pending} className="btn text-xs shrink-0">
        {pending ? "Withdrawing\u2026" : "Withdraw"}
      </button>
    </li>
  );
}
