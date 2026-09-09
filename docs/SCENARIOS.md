# The six evaluation scenarios

Each one walked end to end, with the click path and what the system actually does. Seeded data is
anchored to the current week, so these work whenever you run them.

Sign in at `/login` — one click per account, password `ShiftSync!2026`.

---

## 1. The Sunday Night Chaos

> *A staff member calls out at 6pm Sunday for a 7pm shift. Walk through the fastest path to finding
> coverage.*

**Path:** sign in as **Marcus** → **Schedule** → click the understaffed shift.

The panel opens with everyone who could work it, already checked against every rule, ranked so the
best answer is at the top. For each person you see the consequence before you commit:

```
Aisha Bello        0h → 5h this week (+5h) · 10h under their target     [Assign]
Sofia Marchetti    Blocked: not available for 5h of this shift
                   (Sat 12 Sep, 18:00–23:00 PDT)
```

One click assigns and notifies them. **Two clicks from noticing the gap to filling it.**

Blocked people are shown *with the reason* rather than hidden — otherwise a manager wonders where
someone went and re-checks by hand. Ranking prefers whoever is furthest **below** their desired
hours, so the fast path also spreads work rather than reaching for whoever is already nearest
overtime.

If nobody qualifies, the staff-side path is **Offer up** on the shift, which notifies every
qualified colleague at once.

---

## 2. The Overtime Trap

> *A manager tries to build a schedule where they don't realise one employee would hit 52 hours. How
> does the system help?*

Three defences, in the order you meet them.

**Before you commit.** Every candidate row shows the projection: `40h → 52h this week (+12h)`,
computed by the same engine that will validate the write.

**At the moment of assigning.** The violation appears in full:

> *This pushes Jamal Osei to 52h this week (from 40h), incurring 12h of overtime above 40h.*

It **warns rather than blocks** — overtime is a cost decision a manager should take knowingly, and
blocking it would break the system in exactly the short-staffed week when it is the right answer.
Their manager is notified too.

**After the fact.** **Insights** → Jamal is at 47.5h in the seeded week, above his 40h target, with
the projected cost and — the part the brief asks for specifically — *which assignment caused it*:

> *Tipped into overtime by the Fri Santa Monica shift*

---

## 3. The Timezone Tangle

> *A staff member is certified at a location in Pacific time and another in Eastern time. They set
> availability as "9am–5pm". What happens?*

**Sofia Marchetti** is exactly this person: based in `America/Los_Angeles`, certified at Santa
Monica and Portland ME, available weekdays 09:00–17:00.

Her availability is anchored to **her own** timezone, because "9 to 5" is a claim about the
speaker's clock. So:

| Shift | Result |
|---|---|
| 09:00–17:00 **Pacific** | Available — it is her 9-to-5 |
| 13:00–17:00 **Eastern** | Available — that is 10:00–14:00 her time |
| 09:00–17:00 **Eastern** | **Blocked**, with the exact gap |

The third gives:

> *Sofia Marchetti is not available for 3h of this shift (Mon 15 Jun, 09:00–12:00 EDT). Her
> availability is set in America/Los_Angeles, while this shift is in America/New_York.*

Three hours, because a 9am Eastern start is 6am for her. Sign in as **Sofia** → **Availability** and
the page states the anchor zone at the top.

**DST is handled, not assumed.** Availability is stored as `(weekday, local wall time, zone)` and
expanded through Luxon per week. Windows are rebuilt as wall clock, never as elapsed minutes from
midnight — on 2026-03-08 in Los Angeles those differ by an hour, so the naive version slides
everyone's availability twice a year. Covered by tests for the spring-forward skipped hour, the
fall-back ambiguous hour, and the 23- and 25-hour days.

---

## 4. The Simultaneous Assignment

> *Two managers both try to assign the same bartender to different locations at the same time. What
> happens?*

**Exactly one wins. Not usually — always.**

One Postgres exclusion constraint makes overlapping assignments *unrepresentable*:

```sql
EXCLUDE USING gist (staff_id WITH =, tstzrange(starts_at, rest_guard_ends_at) WITH &&)
  WHERE (status = 'active')
```

The loser's transaction is refused by the database with `SQLSTATE 23P01`. There is no window in
which both succeed, at any isolation level, with no application locking at all.

They do not see a raw error. The rules engine re-runs on a fresh connection and produces the same
sentence they would have got had they simply been slower:

> *Jamal Osei is already working Coastal Eats Venice on Fri 11 Sep, 18:00–02:00 PDT, which overlaps
> this shift.*

…together with alternatives who *can* take it. Their grid updates live over Realtime.

Shift **edits** use optimistic concurrency instead: a stale `version` affects zero rows and returns
409 with current server state.

**To verify:** `pnpm exec vitest run tests/concurrency`. It proves this twice — through the
application path, and through two bare transactions with **no** application locking, showing the
invariant belongs to the schema rather than to our code being careful.

---

## 5. The Fairness Complaint

> *An employee claims they never get Saturday night shifts. How does a manager verify or refute
> this?*

**Insights → Fairness.** Premium shifts are Friday and Saturday evenings, tagged in each location's
own timezone. On the seeded data, over 4 weeks:

| Staff | Premium shifts | Vs fair share |
|---|---|---|
| Rina Okafor | 8 | 2.09× |
| Noor Haddad | 7 | 1.83× |
| Hannah Pryce | 6 | 1.57× |
| **Aisha Bello** | **0** | **0.00×** |
| Jamal Osei | 0 | 0.00× |

Aisha's complaint is **true**, and the manager can see it in seconds rather than argue about it. A
Gini coefficient sits alongside the raw counts — 0.46 on this data, *"concentrated in a few
people"* — but never instead of them: a single number settles no argument, though it does say
whether there is one.

The same view shows average weekly hours against each person's stated target, which is the
under/over-scheduled report the brief asks for.

---

## 6. The Regret Swap

> *Staff A and B request a swap. The manager hasn't approved it yet. Staff A changes their mind.
> What are the implications?*

**None — and that is by design, not by luck.**

The original assignment **never moves** before manager approval. Not when the request is made, not
when the other person accepts. So there is nothing to unwind:

1. Sign in as **Rina** → **My shifts** → *Ask someone* → pick a colleague.
2. Sign in as that colleague → **Accept**. The state becomes `pending_manager`. Rina is *still*
   scheduled, and the UI says so.
3. Sign in as **Rina** again → **Withdraw**.

The request becomes `withdrawn`, Rina keeps the shift, and the counterparty is told plainly:

> *The request for … was withdrawn. You are not scheduled for it.*

The manager is notified only if it had already reached their queue. No penalty is applied — it is
audit-logged, and it frees one of Rina's three pending slots. Penalising withdrawal would just push
people to stop turning up instead.

**Once approved**, withdrawal is refused with *"This swap has already been approved. Ask your
manager to reverse it."* — because by then it is a real schedule change affecting a real person.

Two related edges, both covered by tests:

- **A manager edits the shift while a swap is pending** → the request is auto-cancelled with
  notification, by a **database trigger**, so it holds even for writes that bypass the application.
- **Approval re-validates against the world as it is then.** If the incoming person's availability
  changed in the days since they accepted, approval is refused with the reason — and the original
  assignee keeps the shift rather than it vanishing into a half-completed transfer.
