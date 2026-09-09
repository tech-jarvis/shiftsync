import { requireRole } from "@/lib/auth";
import { OnDutyBoard } from "@/components/onduty/OnDutyBoard";

/**
 * Who is working right now, at every location, updating live.
 *
 * ASSUMPTION (documented in DECISIONS.md): the brief says "currently clocked
 * into a shift", but there is no time clock in this system -- nobody punches
 * in. "On duty" therefore means scheduled and inside the shift window right
 * now. Building a whole time-and-attendance feature to satisfy one dashboard
 * would have been a much larger claim than the brief makes.
 *
 * The board needs two update sources, because two different things change it:
 * assignment rows change (a swap is approved) and the clock advances (a shift
 * simply ends). Realtime covers the first; a ticking interval covers the
 * second, which emits no database event at all.
 */
export default async function OnDutyPage() {
  const user = await requireRole("manager", "admin");
  return <OnDutyBoard locationIds={user.locationIds} />;
}
