-- ShiftSync :: staff availability (recurring weekly + one-off exceptions)

-- ---------------------------------------------------------------------------
-- Two representation decisions worth stating up front
-- ---------------------------------------------------------------------------
--
-- 1. WEEKDAY NUMBERING is ISO-8601: 1 = Monday ... 7 = Sunday. This matches
--    Luxon's `DateTime.weekday` exactly. Postgres `extract(dow)` uses
--    0 = Sunday, so the two must never be mixed -- and since the rules engine
--    (not SQL) evaluates availability, ISO wins.
--
-- 2. WINDOWS ARE MINUTES FROM LOCAL MIDNIGHT, not `time` values, and
--    `end_minute` may exceed 1440 to express a window running past midnight
--    (22:00-02:00 is stored as 1320 -> 1560). Storing wall-clock `time` would
--    force every consumer to branch on "does this wrap?"; an unbounded end
--    minute makes the arithmetic uniform and directly unit-testable.
--
-- Availability is interpreted in `timezone` below -- NOT in the location's
-- timezone. This is the brief's "Timezone Tangle": "9am-5pm" is meaningless
-- until you know whose 9am, and the answer is the staff member's own.
--
-- IMPORTANT: expansion of these rules into concrete instants (which requires
-- DST-correct arithmetic) lives ONLY in src/rules/availability.ts. It is
-- deliberately not reimplemented in SQL -- two implementations of DST handling
-- would eventually disagree, and the disagreement would be silent.

create table availability_rules (
  id           uuid     primary key default gen_random_uuid(),
  staff_id     uuid     not null references profiles(id) on delete cascade,

  iso_weekday  smallint not null,
  start_minute integer  not null,
  end_minute   integer  not null,

  -- Defaulted from profiles.home_timezone at write time. Kept on the row so a
  -- staff member relocating does not silently reinterpret historical windows.
  timezone     text     not null,

  created_at   timestamptz not null default now(),

  constraint weekday_is_iso     check (iso_weekday between 1 and 7),
  constraint start_within_day   check (start_minute >= 0 and start_minute < 1440),
  constraint window_is_ordered  check (end_minute > start_minute),
  constraint window_max_one_day check (end_minute <= start_minute + 1440)
);

create index availability_rules_staff_idx on availability_rules (staff_id, iso_weekday);

create trigger availability_rules_validate_timezone
  before insert or update of timezone on availability_rules
  for each row execute function validate_timezone_column('timezone');

-- ---------------------------------------------------------------------------
-- One-off exceptions
-- ---------------------------------------------------------------------------
-- Three shapes, all expressible with one nullable window:
--
--   is_available = false, window NULL  -> unavailable all day  (called out sick)
--   is_available = false, window set   -> unavailable 14:00-18:00 (dentist)
--   is_available = true,  window set   -> extra availability beyond the
--                                         recurring rules (picking up a day)
--
-- Exceptions always win over recurring rules for that local date.

create table availability_exceptions (
  id           uuid     primary key default gen_random_uuid(),
  staff_id     uuid     not null references profiles(id) on delete cascade,

  on_date      date     not null,
  is_available boolean  not null,
  start_minute integer,
  end_minute   integer,

  timezone     text     not null,
  reason       text,
  created_at   timestamptz not null default now(),

  constraint window_is_all_or_nothing check (
    (start_minute is null and end_minute is null)
    or (start_minute is not null and end_minute is not null)
  ),
  constraint available_exception_needs_window check (
    is_available = false or start_minute is not null
  ),
  constraint exception_start_within_day check (
    start_minute is null or (start_minute >= 0 and start_minute < 1440)
  ),
  constraint exception_window_ordered check (
    end_minute is null or end_minute > start_minute
  ),
  constraint exception_window_max_one_day check (
    end_minute is null or end_minute <= start_minute + 1440
  ),

  unique (staff_id, on_date, start_minute)
);

create index availability_exceptions_staff_idx
  on availability_exceptions (staff_id, on_date);

create trigger availability_exceptions_validate_timezone
  before insert or update of timezone on availability_exceptions
  for each row execute function validate_timezone_column('timezone');
