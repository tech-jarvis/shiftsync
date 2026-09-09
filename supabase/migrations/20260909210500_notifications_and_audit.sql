-- ShiftSync :: notifications, email simulation, rule overrides, audit trail

-- ---------------------------------------------------------------------------
-- Notification preferences
-- ---------------------------------------------------------------------------
-- The brief asks for "in-app only, or in-app + email simulation", which is
-- literally one boolean. In-app notifications are always delivered; email
-- simulation is opt-in. Kept deliberately minimal (see the "deliberately thin"
-- section of the docs).

alter table profiles
  add column email_simulation_enabled boolean not null default false;

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------

create table notifications (
  id            uuid        primary key default gen_random_uuid(),
  recipient_id  uuid        not null references profiles(id) on delete cascade,

  kind          text        not null,
  title         text        not null,
  body          text        not null,

  -- Deep-link target, so the notification centre can navigate to the thing
  -- that changed rather than just describing it.
  entity_type   text,
  entity_id     uuid,

  channel       notification_channel not null default 'in_app',
  read_at       timestamptz,
  created_at    timestamptz not null default now()
);

create index notifications_recipient_idx
  on notifications (recipient_id, created_at desc);
create index notifications_unread_idx
  on notifications (recipient_id) where read_at is null;

-- ---------------------------------------------------------------------------
-- Email simulation outbox
-- ---------------------------------------------------------------------------
-- "Email simulation" is a persisted outbox with a viewer, not real SMTP. Rows
-- are written for recipients who opted in, and rendered in an admin-visible
-- mailbox view so the evaluator can confirm delivery would have happened.

create table email_outbox (
  id              uuid        primary key default gen_random_uuid(),
  notification_id uuid        references notifications(id) on delete cascade,
  to_email        text        not null,
  subject         text        not null,
  body            text        not null,
  created_at      timestamptz not null default now()
);

create index email_outbox_created_idx on email_outbox (created_at desc);

-- Fan a notification out to the simulated email channel when the recipient has
-- opted in. Doing this in the database means every notification-producing code
-- path gets it for free.
create or replace function fanout_notification_to_email()
returns trigger
language plpgsql
as $$
declare
  v_email   text;
  v_opted_in boolean;
begin
  select email, email_simulation_enabled
    into v_email, v_opted_in
    from profiles where id = new.recipient_id;

  if v_opted_in then
    insert into email_outbox (notification_id, to_email, subject, body)
    values (new.id, v_email, new.title, new.body);
  end if;

  return null;
end;
$$;

create trigger notifications_fanout_email
  after insert on notifications
  for each row when (new.channel = 'in_app')
  execute function fanout_notification_to_email();

-- ---------------------------------------------------------------------------
-- Documented rule overrides
-- ---------------------------------------------------------------------------
-- The brief requires a 7th consecutive day to need "manager override with
-- documented reason". `reason` is NOT NULL with a length floor, so an override
-- literally cannot be recorded without documentation.

create table rule_overrides (
  id            uuid          primary key default gen_random_uuid(),
  assignment_id uuid          not null references assignments(id) on delete cascade,
  rule_code     text          not null,
  severity      rule_severity not null,
  reason        text          not null,
  approved_by   uuid          not null references profiles(id),
  created_at    timestamptz   not null default now(),

  constraint override_reason_is_substantive check (length(btrim(reason)) >= 10)
);

create index rule_overrides_assignment_idx on rule_overrides (assignment_id);

-- ---------------------------------------------------------------------------
-- Audit trail
-- ---------------------------------------------------------------------------
-- Written by triggers, never by application code. An audit row you can forget
-- to write is not an audit trail; this one is emitted by the same transaction
-- that made the change, on every write path including psql and Studio.
--
-- The acting user is passed down via a transaction-local setting:
--     set local app.actor_id = '<profile uuid>';
-- which src/db/withActor.ts sets at the start of every mutating transaction.
-- A NULL actor means the change came from a migration, the seed script, or a
-- background job -- which is itself useful information.

create table audit_log (
  id           bigserial   primary key,
  actor_id     uuid        references profiles(id) on delete set null,
  entity_type  text        not null,
  entity_id    uuid,
  action       text        not null,
  before_state jsonb,
  after_state  jsonb,
  occurred_at  timestamptz not null default now()
);

create index audit_log_entity_idx on audit_log (entity_type, entity_id, occurred_at desc);
create index audit_log_time_idx   on audit_log (occurred_at desc);
create index audit_log_actor_idx  on audit_log (actor_id, occurred_at desc);

create or replace function audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
begin
  begin
    v_actor := nullif(current_setting('app.actor_id', true), '')::uuid;
  exception when others then
    v_actor := null;
  end;

  insert into audit_log (
    actor_id, entity_type, entity_id, action, before_state, after_state
  )
  values (
    v_actor,
    tg_table_name,
    coalesce(to_jsonb(new) ->> 'id', to_jsonb(old) ->> 'id')::uuid,
    lower(tg_op),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end
  );

  return null;
end;
$$;

-- Every table whose history a manager or admin may need to explain.
create trigger shifts_audit
  after insert or update or delete on shifts
  for each row execute function audit_row_change();

create trigger assignments_audit
  after insert or update or delete on assignments
  for each row execute function audit_row_change();

create trigger swap_requests_audit
  after insert or update or delete on swap_requests
  for each row execute function audit_row_change();

create trigger staff_certifications_audit
  after insert or update or delete on staff_certifications
  for each row execute function audit_row_change();

create trigger availability_rules_audit
  after insert or update or delete on availability_rules
  for each row execute function audit_row_change();

create trigger availability_exceptions_audit
  after insert or update or delete on availability_exceptions
  for each row execute function audit_row_change();

create trigger rule_overrides_audit
  after insert or update or delete on rule_overrides
  for each row execute function audit_row_change();
