"use client";

import { DateTime } from "luxon";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { decide } from "@/app/(app)/coverage/actions";
import { ViolationList } from "@/components/ViolationList";
import { createClient } from "@/lib/supabase/browser";
import type { Violation } from "@/rules/types";

export interface CoverageRequestView {
  id: string;
  kind: "swap" | "drop";
  state: string;
  requesterName: string;
  incomingName: string | null;
  startsAt: string;
  endsAt: string;
  locationName: string;
  locationTimezone: string;
  skillName: string;
  isPremium: boolean;
  expiresAt: string | null;
}

const STATE_LABEL: Record<string, string> = {
  pending_target: "Waiting for the colleague to accept",
  open: "Open — nobody has claimed it yet",
  pending_manager: "Awaiting your approval",
};

export function CoverageQueue({
  awaitingApproval,
  inFlight,
}: {
  awaitingApproval: CoverageRequestView[];
  inFlight: CoverageRequestView[];
}) {
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("coverage")
      .on("postgres_changes", { event: "*", schema: "public", table: "swap_requests" }, () =>
        router.refresh(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [router]);

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-xs font-semibold mb-2 text-[var(--text-muted)]">Needs a decision</h2>
        {awaitingApproval.length === 0 ? (
          <p className="text-sm text-[var(--text-subtle)]">Nothing waiting.</p>
        ) : (
          <ul className="space-y-2">
            {awaitingApproval.map((request) => (
              <DecisionCard key={request.id} request={request} />
            ))}
          </ul>
        )}
      </section>

      {inFlight.length > 0 ? (
        <section>
          <h2 className="text-xs font-semibold mb-2 text-[var(--text-muted)]">
            In flight (no action needed yet)
          </h2>
          <ul className="space-y-2">
            {inFlight.map((request) => (
              <li key={request.id} className="card px-3 py-2.5">
                <RequestSummary request={request} />
                <p className="text-xs text-[var(--text-subtle)] mt-1">
                  {STATE_LABEL[request.state] ?? request.state}
                  {request.expiresAt
                    ? ` · expires ${DateTime.fromISO(request.expiresAt).toRelative()}`
                    : ""}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function RequestSummary({ request }: { request: CoverageRequestView }) {
  const start = DateTime.fromISO(request.startsAt, { zone: request.locationTimezone });
  const end = DateTime.fromISO(request.endsAt, { zone: request.locationTimezone });
  const overnight = !start.hasSame(end, "day");

  return (
    <>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium">
          {request.requesterName}
          {request.incomingName ? (
            <>
              {" → "}
              <span>{request.incomingName}</span>
            </>
          ) : null}
        </span>
        <span className="badge" style={{ background: "var(--surface-sunken)", color: "var(--text-muted)" }}>
          {request.kind === "drop" ? "Offered up" : "Swap"}
        </span>
        {request.isPremium ? (
          <span className="badge" style={{ background: "var(--premium)", color: "#fff" }}>
            Premium
          </span>
        ) : null}
      </div>
      <p className="text-xs text-[var(--text-muted)] mt-0.5 tnum">
        {start.toFormat("EEE d LLL, HH:mm")}–{end.toFormat("HH:mm")}
        {overnight ? " (+1)" : ""} {start.toFormat("ZZZZ")} · {request.locationName} ·{" "}
        {request.skillName}
      </p>
    </>
  );
}

function DecisionCard({ request }: { request: CoverageRequestView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [violations, setViolations] = useState<Violation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const act = (approve: boolean) =>
    startTransition(async () => {
      setViolations(null);
      setError(null);

      const outcome = await decide(request.id, approve, note || undefined);

      if (outcome.status === "approved" || outcome.status === "updated") {
        router.refresh();
        return;
      }
      if (outcome.status === "rejected") {
        // Re-validated at approval time and no longer legal. Show why.
        setViolations(outcome.violations ?? null);
        setError(outcome.reason);
        router.refresh();
        return;
      }
      setError("message" in outcome ? outcome.message : "Could not complete that.");
    });

  return (
    <li className="card p-3" style={{ borderColor: "var(--accent)" }}>
      <RequestSummary request={request} />

      {error ? (
        <p className="text-xs mt-2" style={{ color: "var(--block)" }}>
          {error}
        </p>
      ) : null}

      {violations && violations.length > 0 ? (
        <div className="mt-2">
          <ViolationList violations={violations} compact />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 mt-3">
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional note (recorded in the audit trail)"
          className="field text-xs flex-1 min-w-[12rem]"
        />
        <button
          type="button"
          onClick={() => act(true)}
          disabled={pending}
          className="btn btn-primary text-xs"
        >
          {pending ? "Approving\u2026" : "Approve"}
        </button>
        <button
          type="button"
          onClick={() => act(false)}
          disabled={pending}
          className="btn btn-danger text-xs"
        >
          {pending ? "Declining\u2026" : "Decline"}
        </button>
      </div>
    </li>
  );
}
