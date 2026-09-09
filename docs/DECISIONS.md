# Decisions and assumptions

The brief marks five questions as **deliberately unspecified** and leaves several more open by
omission. Every call is recorded here with the reasoning, because on an ambiguous requirement the
reasoning *is* the answer.

---

## The five explicit ambiguities

### 1. What happens to historical data when a staff member is de-certified from a location?

**Nothing is rewritten. History stands.**

A certification is a row with `effective_from` and a nullable `effective_to`. De-certifying closes
the period; it never deletes the row and never touches past assignments. Eligibility is judged
**as of the shift's date**, not as of today — so a shift worked in January is still explicable in
March after the certification ends, and the audit trail continues to make sense.

Future assignments at that location are *flagged for manager review* rather than silently dropped.
Silently unassigning someone would create an unstaffed shift that nobody was told about, which is
the exact failure the brief opens with.

*In the seed:* Eli Bergstrom was de-certified from Providence 30 days ago and still has a
historical assignment there.

### 2. How should "desired hours" interact with availability windows?

**Availability is a hard constraint. Desired hours are a soft target that never blocks.**

They answer different questions. Availability is *can* — the hours you are able to work, so
scheduling outside them is an error. Desired hours are *want* — roughly how much work you would
like, so exceeding them is a fairness signal, not a violation.

Desired hours therefore feed three things and gate nothing: the what-if projection ("would take
them 4h over target"), the ranking of coverage suggestions (whoever is furthest *below* target is
offered first), and the under/over-scheduled column in Insights.

### 3. When calculating consecutive days, does a 1-hour shift count the same as an 11-hour one?

**Yes for the day count — but the hours travel with the warning.**

A day on which you had to travel to work and be present is a day not rested, which is what
consecutive-day protections exist to limit, and it is how labour rules are written. Discounting
short shifts would also be trivially gameable: six 1-hour days would read as a rest week.

But the two are not equally severe in substance, so the run's real hours are carried in the
violation and printed in the message — *"6th consecutive day worked — 6 days totalling 26h"*. The
rule is simple; the manager still sees the difference.

**Related:** runs are **not** reset at the week boundary. The brief says "in a week", but a run from
Sunday into Monday is exactly as tiring as one inside a single week. Counting the true run is the
more protective reading and never under-reports.

### 4. If a shift is edited after swap approval but before it occurs, what should happen?

**Approval transferred ownership. A later edit is an ordinary edit against the new assignee.**

Once approved, the shift simply belongs to the new person; there is no lingering swap to reason
about. The edit is re-validated against *their* constraints, and both the previous and current
assignee are notified — the previous one because they may still believe they are involved.

This is distinct from editing a shift with a swap **still pending**, which the brief does specify:
that cancels the request automatically. That cancellation is a database trigger, not service code,
so it holds even for writes that bypass the application.

### 5. How should the system handle a location spanning a timezone boundary?

**One IANA timezone per location — its operating timezone.**

A restaurant near a state line still opens, closes, and pays overtime on one clock: whichever one
its staff rota is written in. Modelling per-shift timezones would add a dimension to every query
and every display to represent something no restaurant actually does.

Timezones are validated against `pg_timezone_names` by a trigger, so a typo like
`America/Los_Angles` fails loudly at write time instead of quietly corrupting every hours
calculation downstream.

---

## Decisions the brief left open by omission

### What does "swap" mean — a handoff or a two-way trade?

**Both are supported.** The brief says "swap a shift with another qualified staff member" and
separately describes offering a shift up, without saying whether a swap is directed or mutual. So:

| Shape | Meaning |
|---|---|
| `swap`, no counter | One-way handoff to a named person, who must accept |
| `swap` + counter | Mutual trade: each takes the other's shift |
| `drop` | Open to anyone qualified; first claim wins |

This costs almost nothing because the rules engine validates a *set* of proposed changes atomically.
A handoff is one change, a trade is two, publishing a week is many — one code path.

### Does picking up an unfilled shift need manager approval?

**No — but taking over someone's dropped shift does.**

The asymmetry is deliberate. A drop releases a person from an obligation, and a manager should see
that. An unfilled shift has no counterparty and is *currently unstaffed*, so coverage is strictly an
improvement; making a manager approve it just slows down the situation the brief cares most about
(scenario 1). The full rules engine runs either way, so nobody picks up a shift that would
double-book them or breach their rest.

### Which day does an overnight shift belong to?

**Its start date**, for daily caps and consecutive-day counting alike. An 11pm–3am shift is 4 hours
on the day it began. Splitting it would let one continuous shift trip the daily warning on two
separate days while working neither of them fully.

### Whose timezone defines "a day" and "a week"?

**The staff member's, for anything about a person. The location's, for anything about a place.**

Daily hours, weekly hours and consecutive days are limits on a person's body, so they aggregate in
that person's own timezone. Using each shift's location zone instead would let one continuous
stretch of work land on two different "days" purely because two shifts were in different states —
which is how a Pacific-to-Eastern double slips past a daily cap.

Premium-shift tagging goes the other way and uses the **location's** zone, because "Friday night" is
a property of the restaurant's evening, not of the employee's clock.

### When does the labour week start?

**Monday (ISO).** The brief says "weekly hours approaching 40" without defining the boundary. Monday
matches ISO-8601 and Luxon's default. It is a single constant if a US Sunday–Saturday week is
wanted instead.

### Is overtime blocked?

**No — it warns.** The brief asks the system to "track and warn about" weekly hours. Overtime is a
cost decision for a manager to take knowingly, not an illegal state, and blocking it would make the
system unusable in exactly the short-staffed week when overtime is the right answer. The 12-hour
daily cap *is* a hard block, and the 7th consecutive day requires a documented override.

### What is "premium"?

A shift **starting at or after 17:00 on a Friday or Saturday, in the location's timezone**. Stored
as a column maintained by a trigger rather than computed per query, so fairness reporting is
indexable. It cannot be a `GENERATED` column: it needs a value from another table and
`timestamptz at time zone text`, which is `STABLE` rather than `IMMUTABLE`.

### "Clocked into a shift" on the on-duty board

There is **no time clock** in this system — nobody punches in. "On duty" therefore means *scheduled
and inside the shift window right now*. Building time-and-attendance to satisfy one dashboard would
have claimed considerably more than the brief asks for.

### Can a manager edit inside the 48-hour cutoff?

**No — and the swap/coverage flow is the intended path instead.** The cutoff is presented as the
boundary of a manager's unilateral editing authority. Genuine emergencies inside it are handled
through swaps and coverage, which are designed for exactly that and keep everyone notified, rather
than by silently rewriting a schedule people have planned their week around. Publishing skips
locked shifts and reports how many it skipped.

---

## Assumptions

- **Staff records exist independently of logins.** `profiles` has its own primary key and a nullable
  `auth_user_id`. A restaurant hires people before they activate an account, and it keeps tests and
  the seed hermetic.
- **One skill per shift.** The brief says "required skill" (singular). A shift needing a bartender
  *and* a cook is two shifts, which is also how headcount stays meaningful.
- **Overtime is paid at 1.5× above 40h/week**, the common US convention, for cost projection.
- **Only one live request per assignment.** Two competing offers for the same shift would let two
  people each believe they had it.
- **Withdrawing a request is unpenalised.** It is audit-logged and frees one of the three pending
  slots. Penalising it would push people to just not turn up instead.
- **Seeded "conflicts" are rule-level, not structural.** Overlapping assignments *cannot* be seeded:
  the exclusion constraint makes them unrepresentable. That is the point of putting it there. So the
  seed carries the conflicts a manager actually reasons about — overtime, consecutive days, a
  de-certification, an understaffed premium shift.
