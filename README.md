# ShiftSync

Multi-location staff scheduling for **Coastal Eats** — 4 restaurants across 2 time zones.

Built for the Priority Soft full-stack assessment. The brief weights 60% of the grade on
constraint correctness, edge cases and data integrity under concurrency, so this is built as a
**constraint engine with a UI on top**, not a calendar with validation bolted on.

---

## Quick start

Requires Node 22+, pnpm, and Docker (for the local Supabase stack).

```bash
pnpm install
pnpm db:start        # starts local Postgres + Auth + Realtime, applies migrations
pnpm seed            # 20 people with logins, 62 shifts, deliberate edge cases
pnpm dev             # http://localhost:3000
```

`pnpm db:start` prints the local keys. Copy `.env.example` to `.env.local` and paste them in —
they are the same on every machine, so the committed defaults usually just work.

```bash
pnpm test            # 101 tests
pnpm typecheck
pnpm lint
```

---

## Logging in

**Every account uses the password `ShiftSync!2026`.** The sign-in screen lists them with one-click
access, so you never need to come back here for a password.

| Email | Role | What they show you |
|---|---|---|
| `admin@coastaleats.test` | Admin | All 4 locations, audit trail, CSV export |
| `marcus@coastaleats.test` | Manager | Santa Monica + Venice (Pacific) |
| `priya@coastaleats.test` | Manager | Portland ME + Providence (Eastern) |
| `tomas@coastaleats.test` | Manager | Venice + Portland — a manager spanning both time zones |
| `sofia@coastaleats.test` | Staff | Pacific-based, certified on **both** coasts, availability "9–5" |
| `jamal@coastaleats.test` | Staff | Projected to **47.5h** this week against a 40h target |
| `rina@coastaleats.test` | Staff | On a **6th consecutive day**; holds 8 premium shifts |
| `aisha@coastaleats.test` | Staff | The fairness complaint — almost never gets Friday/Saturday nights |
| `noor@coastaleats.test` | Staff | Has an open drop request inside its expiry window |
| `eli@coastaleats.test` | Staff | De-certified from Providence, but worked there historically |

Sign in as **Marcus** to see the manager experience, then as **Sofia** to see the same schedule
from the other side.

---

## How it is built

**Next.js 15 (App Router) · TypeScript · Supabase Postgres, Auth and Realtime · Luxon · Vitest**

```
src/rules/          the constraint engine — pure, synchronous, database-free
src/domain/         services that bridge the engine to the database
src/db/             connection, transactions, advisory locks
src/app/            routes; (app)/ is the authenticated shell
supabase/migrations raw SQL — constraints, triggers, RLS, grants
tests/              rules (pure) · concurrency · swaps · service (real Postgres)
```

### The three ideas that carry the design

**1. Integrity is structural, not checked.** One Postgres GiST exclusion constraint enforces both
no-double-booking *and* the 10-hour minimum rest, by padding each assignment's range forward 10
hours and forbidding overlap:

```sql
EXCLUDE USING gist (
  staff_id WITH =,
  tstzrange(starts_at, rest_guard_ends_at) WITH &&
) WHERE (status = 'active')
```

Two concurrent transactions cannot both commit, at any isolation level, with no application
locking. The race window does not exist. Verified to the minute: 9h59m rejected, exactly 10h
allowed, symmetric under insert order.

Rules that span many rows (weekly hours, consecutive days, headcount) can't be expressed that way,
so they run under per-staff and per-shift advisory locks — always taken staff-first, so no deadlock
cycle is possible.

**2. The rules engine explains; the database guarantees.** `src/rules/` is pure and takes plain
data, which is why every constraint — including DST edges — is unit-tested in milliseconds. It runs
before a write for a clear message, again after a `23P01` rejection to turn an opaque SQLSTATE into
a sentence naming the conflicting shift, and again in the what-if preview, so the number a manager
reads before confirming is the number the rules will use.

**3. Time is instants; wall clock only at the edges.** Everything is `timestamptz`. Availability is
stored as `(weekday, local wall time, IANA zone)` anchored to the **staff member's own** timezone
and expanded per week through Luxon — never as a cached UTC offset, which is what breaks on DST.

Availability minutes are rebuilt as *wall clock*, not added to midnight as elapsed time. On
2026-03-08 in Los Angeles those differ by an hour:

```
midnight.plus({ minutes: 540 })  ->  10:00   wrong
wall-clock 09:00                 ->  09:00   right
```

**Authorization is RLS, and only RLS.** Policies are the single access layer, so a rule can't be
forgotten in the seventeenth query touching shifts — and because Supabase Realtime evaluates the
same policies, per-user event filtering comes free. Verified: Marcus sees only his 2 locations;
Sofia sees published shifts at her 2 certified locations and exactly 1 profile (her own).

**The audit trail is written by triggers**, never by application code, so it also records changes
made in psql or Studio. An audit row you can forget to write is not an audit trail.

---

## Deployment

The hosted Supabase backend is **live and seeded**: project `znitqahbagliydjhgakv`, region
ap-southeast-2. All 9 migrations are applied, the seed has run, and it was verified end to end —
sign-in works, RLS scopes correctly (a manager sees only their locations; staff see published
shifts at their certified locations and no drafts), and the exclusion constraint rejects an
overlapping assignment with `SQLSTATE 23P01`.

What remains is pointing a Vercel deployment at it.

```bash
vercel --prod
```

Four environment variables, all present in `.env.hosted` (gitignored) — copy them across:

| Variable | Notes |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://znitqahbagliydjhgakv.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public by design; RLS is what protects the data |
| `SUPABASE_SERVICE_ROLE_KEY` | **Server-side only.** Bypasses RLS entirely |
| `DATABASE_URL` | Session pooler. Required — see below |

`DATABASE_URL` is not optional. The app holds a direct Postgres connection for transactions and
per-staff advisory locks, which is what makes the concurrency guarantees work; PostgREST alone
cannot express them.

Two things about that URL worth not rediscovering the hard way:

- **Session pooler (port 5432), not transaction pooler (6543).** Transaction pooling breaks
  session-level advisory locks and postgres.js prepared statements.
- **The password must be percent-encoded.** This project's contains `@` and `%`, which would
  otherwise terminate the userinfo section and open an escape sequence. The direct host
  (`db.<ref>.supabase.co`) is IPv6-only and unreachable from most IPv4 networks, which is the
  other reason to use the pooler.

To re-seed the hosted database at any point:

```bash
set -a; . ./.env.hosted; set +a
pnpm exec tsx scripts/seed.ts
```

The seed is idempotent — existing auth users are reused rather than duplicated, so it can be run
repeatedly without breaking logins.

## Documentation

- **[docs/DECISIONS.md](docs/DECISIONS.md)** — every ambiguity the brief left open, the call made,
  and why. Read this one first.
- **[docs/SCENARIOS.md](docs/SCENARIOS.md)** — the six evaluation scenarios, each walked end to end
  with the exact click path.

## Known limitations

Stated plainly rather than hidden. Effort was concentrated where the rubric is, and these are the
places it was deliberately spent lightly:

- **No time clock.** Nobody punches in, so "on duty now" means *scheduled and inside the shift
  window*. Building time-and-attendance to satisfy one dashboard would claim more than the brief
  asks.
- **Email is simulated.** Opted-in notifications write to an `email_outbox` table with an
  admin-visible viewer. No SMTP.
- **Drop expiry is swept lazily.** Reads filter on `expires_at`, so correctness never depends on a
  scheduler running; a cron would only be needed to emit the expiry *notifications* promptly.
- **The 10-hour rest period is not runtime-configurable.** It is a literal in the exclusion
  constraint, because constraint expressions must be `IMMUTABLE`. Changing it needs a migration —
  an acceptable trade for making the guarantee unbreakable. The brief only requires the *edit
  cutoff* to be configurable, and that one is (`app_settings`).
- **Admin CRUD for people and locations is seed-driven.** Roles, certifications and skills are set
  up by the seed rather than through an admin UI. The RLS policies and grants for it are in place.
- **Fairness reporting is tabular.** Bars beside exact figures rather than a charting library.
