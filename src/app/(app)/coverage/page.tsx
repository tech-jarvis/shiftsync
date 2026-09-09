import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { CoverageQueue, type CoverageRequestView } from "@/components/coverage/CoverageQueue";

/**
 * The manager's approval queue.
 *
 * Only requests that have reached `pending_manager` need a decision -- a swap
 * still waiting on its target is not the manager's problem yet. Requests still
 * in flight elsewhere are shown separately for visibility, without inviting an
 * action that would be premature.
 */

export default async function CoveragePage() {
  const user = await requireRole("manager", "admin");
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("swap_requests")
    .select(
      `id, kind, state, expires_at, created_at,
       requester:profiles!swap_requests_requester_id_fkey(id, full_name),
       target:profiles!swap_requests_target_staff_id_fkey(id, full_name),
       claimant:profiles!swap_requests_claimed_by_fkey(id, full_name),
       assignment:assignments!swap_requests_requester_assignment_id_fkey(
         id, starts_at, ends_at,
         shift:shifts!assignments_shift_id_fkey(
           id, is_premium,
           location:locations(id, name, timezone),
           skill:skills(name)
         )
       )`,
    )
    .in("state", ["pending_manager", "pending_target", "open"])
    .order("created_at", { ascending: true });

  const requests: CoverageRequestView[] = (data ?? []).map((row) => {
    const assignment = row.assignment as unknown as {
      starts_at: string;
      ends_at: string;
      shift: {
        is_premium: boolean;
        location: { name: string; timezone: string } | null;
        skill: { name: string } | null;
      } | null;
    } | null;

    const name = (value: unknown) =>
      (value as { full_name: string } | null)?.full_name ?? null;

    return {
      id: row.id,
      kind: row.kind as "swap" | "drop",
      state: row.state as string,
      requesterName: name(row.requester) ?? "—",
      incomingName: name(row.claimant) ?? name(row.target),
      startsAt: assignment?.starts_at ?? "",
      endsAt: assignment?.ends_at ?? "",
      locationName: assignment?.shift?.location?.name ?? "—",
      locationTimezone: assignment?.shift?.location?.timezone ?? "UTC",
      skillName: assignment?.shift?.skill?.name ?? "—",
      isPremium: assignment?.shift?.is_premium ?? false,
      expiresAt: row.expires_at,
    };
  });

  const awaitingMe = requests.filter((r) => r.state === "pending_manager");
  const inFlight = requests.filter((r) => r.state !== "pending_manager");

  return (
    <div className="max-w-4xl space-y-5">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">Coverage</h1>
        <p className="text-sm text-[var(--text-muted)] mt-0.5">
          {awaitingMe.length === 0
            ? "Nothing needs your approval."
            : `${awaitingMe.length} request${awaitingMe.length === 1 ? "" : "s"} awaiting your approval`}
          {user.role === "admin" ? " · across all locations" : ""}
        </p>
      </header>

      {error ? (
        <p
          className="card p-3 text-sm"
          style={{ borderColor: "var(--block)", background: "var(--block-soft)" }}
        >
          Could not load coverage requests: {error.message}
        </p>
      ) : (
        <CoverageQueue awaitingApproval={awaitingMe} inFlight={inFlight} />
      )}
    </div>
  );
}
