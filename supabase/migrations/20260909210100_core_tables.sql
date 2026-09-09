-- ShiftSync :: locations, people, skills, certifications

-- ---------------------------------------------------------------------------
-- Timezone validation
-- ---------------------------------------------------------------------------
-- A typo'd timezone ('America/Los_Angles') would silently corrupt every hours
-- calculation downstream rather than failing loudly, so validate against the
-- Postgres catalog. This cannot be a CHECK constraint: reading
-- pg_timezone_names is not IMMUTABLE. A trigger is the correct tool.
--
-- Takes the column name as a trigger argument so one function serves every
-- table that stores an IANA zone.

create or replace function validate_timezone_column()
returns trigger
language plpgsql
as $$
declare
  v_column text := tg_argv[0];
  v_value  text;
begin
  execute format('select ($1).%I', v_column) into v_value using new;

  if v_value is null
     or not exists (select 1 from pg_timezone_names where name = v_value) then
    raise exception 'invalid IANA timezone in %.%: %', tg_table_name, v_column, v_value
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Locations
-- ---------------------------------------------------------------------------
-- One IANA timezone per location (see DECISIONS.md: a restaurant near a state
-- line picks its operating timezone; per-shift timezones are not modelled).

create table locations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  slug       text not null unique,
  timezone   text not null,
  created_at timestamptz not null default now()
);

create trigger locations_validate_timezone
  before insert or update of timezone on locations
  for each row execute function validate_timezone_column('timezone');

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------
-- DESIGN NOTE: `profiles` owns its own primary key and links to auth.users via
-- a nullable `auth_user_id`, rather than using auth.users(id) as the PK.
--
-- Why: a staff record exists whether or not that person has ever activated a
-- login -- which is the norm for restaurant staff. It also lets tests and the
-- seed script create people without going through the auth admin API, which
-- keeps the concurrency tests fast and hermetic.

create table profiles (
  id                   uuid primary key default gen_random_uuid(),
  auth_user_id         uuid unique references auth.users(id) on delete set null,
  full_name            text not null,
  email                text not null unique,
  role                 user_role not null,

  -- The anchor timezone for this person's availability windows. This is the
  -- answer to the brief's "Timezone Tangle": availability of "9am-5pm" is
  -- meaningless without knowing whose 9am. It is theirs.
  home_timezone        text not null,

  -- Soft target, never a constraint (see DECISIONS.md). Feeds fairness
  -- analytics and under/over-scheduling reports only.
  desired_weekly_hours numeric(5,2),

  -- Required for the projected-overtime-cost dashboard.
  hourly_rate          numeric(8,2) not null default 0,

  is_active            boolean not null default true,
  created_at           timestamptz not null default now()
);

create trigger profiles_validate_home_timezone
  before insert or update of home_timezone on profiles
  for each row execute function validate_timezone_column('home_timezone');

create index profiles_role_idx on profiles (role) where is_active;

-- ---------------------------------------------------------------------------
-- Manager -> location scope. Drives every RLS policy for the manager role.
-- ---------------------------------------------------------------------------

create table manager_locations (
  manager_id  uuid not null references profiles(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  primary key (manager_id, location_id)
);

create index manager_locations_location_idx on manager_locations (location_id);

-- ---------------------------------------------------------------------------
-- Skills
-- ---------------------------------------------------------------------------

create table skills (
  id   uuid primary key default gen_random_uuid(),
  name text not null unique,
  slug text not null unique
);

create table staff_skills (
  staff_id uuid not null references profiles(id) on delete cascade,
  skill_id uuid not null references skills(id) on delete cascade,
  primary key (staff_id, skill_id)
);

-- ---------------------------------------------------------------------------
-- Location certifications
-- ---------------------------------------------------------------------------
-- De-certification closes `effective_to` instead of deleting the row, so a
-- shift worked last month stays explicable even after the person loses that
-- certification today (see DECISIONS.md).

create table staff_certifications (
  id             uuid primary key default gen_random_uuid(),
  staff_id       uuid not null references profiles(id) on delete cascade,
  location_id    uuid not null references locations(id) on delete cascade,
  effective_from date not null default current_date,
  effective_to   date,

  constraint certification_period_ordered
    check (effective_to is null or effective_to >= effective_from),

  -- A person cannot hold two overlapping certification periods for the same
  -- location. btree_gist again: uuid `=` alongside daterange `&&`.
  constraint no_overlapping_certifications
    exclude using gist (
      staff_id    with =,
      location_id with =,
      daterange(effective_from, effective_to, '[]') with &&
    )
);

create index staff_certifications_lookup_idx
  on staff_certifications (staff_id, location_id);

-- Was this person certified at this location on this date?
create or replace function is_certified_on(
  p_staff_id    uuid,
  p_location_id uuid,
  p_on          date
)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
      from staff_certifications c
     where c.staff_id    = p_staff_id
       and c.location_id = p_location_id
       and p_on >= c.effective_from
       and (c.effective_to is null or p_on <= c.effective_to)
  );
$$;
