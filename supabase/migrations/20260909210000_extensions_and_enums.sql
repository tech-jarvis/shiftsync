-- ShiftSync :: extensions, enums and shared helpers
--
-- btree_gist is MANDATORY, not optional: the assignments exclusion constraint
-- compares a uuid (staff_id) with `=` alongside a tstzrange with `&&`. Plain
-- GiST has no default operator class for uuid, so without this extension the
-- constraint in 20260909210300 fails with:
--   ERROR: data type uuid has no default operator class for access method "gist"

create extension if not exists btree_gist;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type user_role as enum ('admin', 'manager', 'staff');

-- 'released' = the staff member was removed from the shift by an approved swap
-- or drop. Rows are never hard-deleted, so history survives (see DECISIONS.md
-- on de-certification). Only 'active' rows participate in the exclusion
-- constraint and in hours calculations.
create type assignment_status as enum ('active', 'released', 'cancelled');

create type swap_kind as enum ('swap', 'drop');

-- Swap:  pending_target -> pending_manager -> approved
-- Drop:  open -> claimed(=pending_manager) -> approved
create type swap_state as enum (
  'pending_target',
  'open',
  'pending_manager',
  'approved',
  'rejected',
  'cancelled',
  'withdrawn',
  'expired'
);

create type notification_channel as enum ('in_app', 'email_sim');

create type rule_severity as enum ('block', 'warn', 'override_required');

-- ---------------------------------------------------------------------------
-- Configurable business parameters
-- ---------------------------------------------------------------------------
-- The brief calls the edit cutoff "configurable (default: 48 hours)". Rather
-- than scatter magic numbers, every tunable lives here and is read by both SQL
-- and the TypeScript rules engine.

create table app_settings (
  key         text primary key,
  value       numeric not null,
  unit        text    not null,
  description text    not null
);

insert into app_settings (key, value, unit, description) values
  ('edit_cutoff_hours',        48, 'hours',   'Published shifts lock this long before start'),
  ('min_rest_hours',           10, 'hours',   'Minimum gap between two shifts for one person'),
  ('daily_hours_warn',          8, 'hours',   'Warn above this many hours in one day'),
  ('daily_hours_block',        12, 'hours',   'Hard block above this many hours in one day'),
  ('weekly_hours_warn',        35, 'hours',   'Warn when projected weekly hours reach this'),
  ('weekly_hours_overtime',    40, 'hours',   'Overtime threshold'),
  ('consecutive_days_warn',     6, 'days',    'Warn on this many consecutive days worked'),
  ('consecutive_days_override', 7, 'days',    'Requires documented manager override'),
  ('max_pending_requests',      3, 'count',   'Max open swap/drop requests per staff member'),
  ('drop_expiry_hours',        24, 'hours',   'Unclaimed drop requests expire this long before start'),
  ('premium_start_hour',       17, 'hour',    'Shifts starting at/after this hour on Fri/Sat are premium');

-- Read a setting as a plain number. Immutable-ish: settings change rarely, but
-- STABLE (not IMMUTABLE) is correct because it reads a table.
create or replace function app_setting(p_key text)
returns numeric
language sql
stable
as $$
  select value from app_settings where key = p_key;
$$;
