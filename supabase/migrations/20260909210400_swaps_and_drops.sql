-- ShiftSync :: shift swaps, drop requests and coverage

-- ---------------------------------------------------------------------------
-- What "swap" means here (an assumption -- the brief is ambiguous)
-- ---------------------------------------------------------------------------
-- The brief says staff can "request to swap a shift with another qualified
-- staff member", and separately offer a shift "up for grabs". It does not say
-- whether a swap is a one-way handoff to a named person or a mutual trade of
-- two shifts. Both readings are reasonable, so both are supported:
--
--   kind = 'swap', counter_assignment_id IS NULL  -> one-way handoff to a
--                                                    named person, who must accept
--   kind = 'swap', counter_assignment_id IS SET   -> mutual trade: requester
--                                                    takes the counter shift,
--                                                    target takes theirs
--   kind = 'drop'                                 -> open to any qualified
--                                                    staff member; first claim wins
--
-- This costs almost nothing because the rules engine validates a *set* of
-- proposed assignment changes atomically rather than one change at a time. A
-- handoff is one change, a trade is two, publishing a week is many -- all the
-- same code path.

create table swap_requests (
  id                     uuid       primary key default gen_random_uuid(),
  kind                   swap_kind  not null,
  state                  swap_state not null,

  -- Who is giving up a shift, and which assignment.
  requester_id           uuid       not null references profiles(id) on delete cascade,
  requester_assignment_id uuid      not null references assignments(id) on delete cascade,

  -- swap only: the person being asked.
  target_staff_id        uuid       references profiles(id) on delete cascade,
  -- swap only, optional: the assignment the requester wants in return.
  counter_assignment_id  uuid       references assignments(id) on delete cascade,

  -- drop only: who picked it up.
  claimed_by             uuid       references profiles(id) on delete set null,
  claimed_at             timestamptz,

  -- drop only: 24h before the shift starts. Enforced two ways -- filtered
  -- lazily on read (so correctness does not depend on a scheduler running)
  -- and swept by cron purely to emit the expiry notifications.
  expires_at             timestamptz,

  -- Free-text reason captured on withdrawal / rejection, surfaced in audit.
  resolution_note        text,
  resolved_by            uuid       references profiles(id) on delete set null,
  resolved_at            timestamptz,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint swap_has_target check (
    kind <> 'swap' or target_staff_id is not null
  ),
  constraint drop_has_no_target check (
    kind <> 'drop' or (target_staff_id is null and counter_assignment_id is null)
  ),
  constraint counter_is_swap_only check (
    counter_assignment_id is null or kind = 'swap'
  ),
  constraint drop_has_expiry check (
    kind <> 'drop' or expires_at is not null
  ),
  -- A swap starts life awaiting the target; a drop starts life open.
  constraint initial_state_matches_kind check (
    state <> 'pending_target' or kind = 'swap'
  ),
  constraint open_state_is_drop_only check (
    state <> 'open' or kind = 'drop'
  ),
  constraint cannot_swap_with_self check (
    target_staff_id is null or target_staff_id <> requester_id
  )
);

create index swap_requests_requester_idx on swap_requests (requester_id, state);
create index swap_requests_target_idx    on swap_requests (target_staff_id, state);
create index swap_requests_assignment_idx on swap_requests (requester_assignment_id);
create index swap_requests_open_idx on swap_requests (state, expires_at)
  where state in ('open', 'pending_target', 'pending_manager');

create trigger swap_requests_touch_updated_at
  before update on swap_requests
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- Which states count as "still in play"
-- ---------------------------------------------------------------------------

create or replace function is_pending_state(p_state swap_state)
returns boolean
language sql
immutable
as $$
  select p_state in ('pending_target', 'open', 'pending_manager');
$$;

-- The requester's original assignment stands until a manager approves, so a
-- request is only "live" while pending AND not past its expiry.
create view live_swap_requests as
  select *
    from swap_requests
   where is_pending_state(state)
     and (expires_at is null or expires_at > now());

-- ---------------------------------------------------------------------------
-- Cap of 3 pending requests per staff member
-- ---------------------------------------------------------------------------
-- Counting sibling rows cannot be expressed as a constraint, so it is a
-- trigger -- and the trigger takes the per-staff advisory lock itself rather
-- than trusting the caller to have taken it. That makes the cap hold even for
-- writes that bypass the application (psql, Studio, a future job).

create or replace function enforce_pending_request_cap()
returns trigger
language plpgsql
as $$
declare
  v_pending integer;
  v_cap     integer := app_setting('max_pending_requests');
begin
  perform pg_advisory_xact_lock(1, hashtext(new.requester_id::text));

  select count(*) into v_pending
    from swap_requests
   where requester_id = new.requester_id
     and is_pending_state(state)
     and (expires_at is null or expires_at > now())
     and id <> new.id;

  if v_pending >= v_cap then
    raise exception
      'staff member already has % pending swap/drop requests (limit %)',
      v_pending, v_cap
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger swap_requests_enforce_cap
  before insert on swap_requests
  for each row when (is_pending_state(new.state))
  execute function enforce_pending_request_cap();

-- ---------------------------------------------------------------------------
-- A manager editing a shift cancels pending requests against it
-- ---------------------------------------------------------------------------
-- Required by the brief. Implemented as a trigger rather than in the service
-- layer so it cannot be bypassed by any write path. Notifications are emitted
-- by the notification trigger in the next migration, which watches state
-- transitions on this table.

create or replace function cancel_requests_on_shift_edit()
returns trigger
language plpgsql
as $$
begin
  if new.starts_at        is distinct from old.starts_at
     or new.ends_at       is distinct from old.ends_at
     or new.location_id   is distinct from old.location_id
     or new.required_skill_id is distinct from old.required_skill_id
     or new.headcount     is distinct from old.headcount then

    update swap_requests sr
       set state           = 'cancelled',
           resolution_note = 'Automatically cancelled: the shift was edited by a manager',
           resolved_at     = now()
     where is_pending_state(sr.state)
       and exists (
         select 1 from assignments a
          where a.id = sr.requester_assignment_id
            and a.shift_id = new.id
       );
  end if;

  return new;
end;
$$;

create trigger shifts_cancel_pending_requests
  after update on shifts
  for each row execute function cancel_requests_on_shift_edit();

-- ---------------------------------------------------------------------------
-- Expiry sweep (notifications only -- reads already filter by expires_at)
-- ---------------------------------------------------------------------------

create or replace function expire_stale_requests()
returns integer
language plpgsql
as $$
declare
  v_expired integer;
begin
  with expired as (
    update swap_requests
       set state           = 'expired',
           resolution_note = 'Expired unclaimed 24 hours before the shift',
           resolved_at     = now()
     where is_pending_state(state)
       and expires_at is not null
       and expires_at <= now()
    returning 1
  )
  select count(*) into v_expired from expired;

  return v_expired;
end;
$$;
