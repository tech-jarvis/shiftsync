import { DateTime } from "luxon";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { MyShifts, type MyShiftView, type PendingRequestView } from "@/components/staff/MyShifts";

/**
 * A staff member's own schedule.
 *
 * Mobile-first: this is read between covers, on a phone, usually to answer
 * "when am I next in?" or "can someone take Friday?".
 *
 * Times are shown in each shift's LOCATION timezone with the zone labelled,
 * because that is the clock the person will actually be standing under. For
 * someone certified on both coasts that means two different zones in one list,
 * which is exactly the honest presentation -- silently normalising them to one
 * zone is how people turn up three hours late.
 */

export default async function StaffPage() {
  const user = await requireUser();
  const supabase = await createClient();

  const { data: assignmentRows, error } = await supabase
    .from("assignments")
    .select(
      `id, starts_at, ends_at, status,
       shift:shifts!assignments_shift_id_fkey(
         id, is_premium, is_published,
         location:locations(name, timezone),
         skill:skills(name)
       )`,
    )
    .eq("staff_id", user.profileId)
    .eq("status", "active")
    .gte("starts_at", DateTime.now().minus({ hours: 12 }).toISO())
    .order("starts_at")
    .limit(40);

  const shifts: MyShiftView[] = (assignmentRows ?? []).map((row) => {
    const shift = row.shift as unknown as {
      id: string;
      is_premium: boolean;
      is_published: boolean;
      location: { name: string; timezone: string } | null;
      skill: { name: string } | null;
    };
    return {
      assignmentId: row.id,
      shiftId: shift.id,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      locationName: shift.location?.name ?? "—",
      locationTimezone: shift.location?.timezone ?? user.homeTimezone,
      skillName: shift.skill?.name ?? "—",
      isPremium: shift.is_premium,
    };
  });

  // Requests addressed to me, and my own still in flight.
  const { data: requestRows } = await supabase
    .from("swap_requests")
    .select(
      `id, kind, state, requester_id, target_staff_id, expires_at,
       requester:profiles!swap_requests_requester_id_fkey(full_name),
       assignment:assignments!swap_requests_requester_assignment_id_fkey(
         starts_at, ends_at,
         shift:shifts!assignments_shift_id_fkey(location:locations(name, timezone))
       )`,
    )
    .in("state", ["pending_target", "open", "pending_manager"])
    .order("created_at", { ascending: false });

  const requests: PendingRequestView[] = (requestRows ?? [])
    .filter((r) => r.requester_id === user.profileId || r.target_staff_id === user.profileId)
    .map((row) => {
      const assignment = row.assignment as unknown as {
        starts_at: string;
        ends_at: string;
        shift: { location: { name: string; timezone: string } | null } | null;
      } | null;
      const requester = row.requester as unknown as { full_name: string } | null;

      return {
        id: row.id,
        kind: row.kind as "swap" | "drop",
        state: row.state as string,
        mine: row.requester_id === user.profileId,
        requesterName: requester?.full_name ?? "A colleague",
        startsAt: assignment?.starts_at ?? "",
        endsAt: assignment?.ends_at ?? "",
        locationName: assignment?.shift?.location?.name ?? "—",
        locationTimezone: assignment?.shift?.location?.timezone ?? user.homeTimezone,
      };
    });

  const weekStart = DateTime.now().setZone(user.homeTimezone).startOf("day").minus({
    days: DateTime.now().setZone(user.homeTimezone).weekday - 1,
  });
  const weekEnd = weekStart.plus({ days: 7 });

  const hoursThisWeek = shifts
    .filter((s) => {
      const start = DateTime.fromISO(s.startsAt, { zone: user.homeTimezone });
      return start >= weekStart && start < weekEnd;
    })
    .reduce(
      (total, s) =>
        total +
        DateTime.fromISO(s.endsAt).diff(DateTime.fromISO(s.startsAt), "hours").hours,
      0,
    );

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">My shifts</h1>
        <p className="text-sm text-[var(--text-muted)] mt-0.5 tnum">
          {Math.round(hoursThisWeek * 10) / 10}h scheduled this week · times shown in each
          location&rsquo;s zone
        </p>
      </header>

      {error ? (
        <p
          className="card p-3 text-sm"
          style={{ borderColor: "var(--block)", background: "var(--block-soft)" }}
        >
          Could not load your shifts: {error.message}
        </p>
      ) : (
        <MyShifts shifts={shifts} requests={requests} profileId={user.profileId} />
      )}
    </div>
  );
}
