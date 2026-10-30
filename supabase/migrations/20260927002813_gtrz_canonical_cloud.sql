-- Canonical cloud state for GTRZ. The application only reaches this schema
-- through the Edge Function using service_role; no client has table access.
create table if not exists gtrz.event_states (
  event_id text primary key check (char_length(event_id) between 1 and 160),
  catalog_payload jsonb not null default jsonb_build_object('products', jsonb_build_array(), 'currentSequence', 0),
  mobile_context jsonb not null default jsonb_build_object(
    'ticketLots', jsonb_build_array(),
    'servicePoints', jsonb_build_array(),
    'voucherCodes', jsonb_build_array(),
    'vouchers', jsonb_build_array(),
    'currentSequence', 0
  ),
  version bigint not null default 0 check (version >= 0),
  updated_at bigint not null default 0 check (updated_at >= 0)
);

create table if not exists gtrz.global_commands (
  sequence bigint generated always as identity primary key,
  command_id text not null unique check (char_length(command_id) between 1 and 160),
  type text not null check (type in ('event.activated', 'event.reset')),
  event_id text not null check (char_length(event_id) between 1 and 160),
  event_name text not null check (char_length(event_name) between 1 and 160),
  reason text,
  created_at bigint not null check (created_at >= 0)
);

create table if not exists gtrz.mobile_operators (
  operator_id text primary key check (char_length(operator_id) between 1 and 80),
  name text not null check (char_length(name) between 1 and 80),
  password_salt text not null check (char_length(password_salt) between 16 and 160),
  password_hash text not null check (char_length(password_hash) between 32 and 256),
  permissions jsonb not null,
  active boolean not null default true,
  created_at bigint not null check (created_at >= 0),
  updated_at bigint not null check (updated_at >= 0)
);

create table if not exists gtrz.mobile_sessions (
  session_id text primary key check (char_length(session_id) between 1 and 160),
  operator_id text not null references gtrz.mobile_operators(operator_id) on delete cascade,
  device_id text not null check (char_length(device_id) between 1 and 160),
  token_hash text not null unique check (char_length(token_hash) between 32 and 256),
  revoked_at bigint,
  expires_at bigint not null check (expires_at >= 0),
  last_seen_at bigint not null check (last_seen_at >= 0),
  created_at bigint not null check (created_at >= 0)
);

create index if not exists mobile_sessions_active_idx
  on gtrz.mobile_sessions (token_hash, expires_at)
  where revoked_at is null;

alter table gtrz.event_states enable row level security;
alter table gtrz.global_commands enable row level security;
alter table gtrz.mobile_operators enable row level security;
alter table gtrz.mobile_sessions enable row level security;

revoke all on all tables in schema gtrz from public, anon, authenticated;
grant select, insert, update, delete on all tables in schema gtrz to service_role;

create or replace function public.gtrz_read_event_state(p_event_id text)
returns jsonb
language sql
security definer
set search_path = gtrz, public, pg_temp
stable
as $$
  select coalesce(
    (
      select jsonb_build_object(
        'catalog', catalog_payload,
        'context', mobile_context,
        'version', version,
        'updatedAt', updated_at
      )
      from event_states
      where event_id = p_event_id
    ),
    jsonb_build_object(
      'catalog', jsonb_build_object('products', jsonb_build_array(), 'currentSequence', 0),
      'context', jsonb_build_object(
        'ticketLots', jsonb_build_array(),
        'servicePoints', jsonb_build_array(),
        'voucherCodes', jsonb_build_array(),
        'vouchers', jsonb_build_array(),
        'currentSequence', 0
      ),
      'version', 0,
      'updatedAt', 0
    )
  );
$$;

create or replace function public.gtrz_replace_event_projection(
  p_event_id text,
  p_projection text,
  p_payload jsonb,
  p_updated_at bigint
) returns jsonb
language plpgsql
security definer
set search_path = gtrz, public, pg_temp
as $$
declare
  v_state event_states%rowtype;
begin
  if char_length(trim(p_event_id)) = 0 or char_length(p_event_id) > 160 then
    raise exception 'INVALID_EVENT_ID';
  end if;
  if p_projection not in ('cashier-catalog', 'mobile-context') or p_payload is null or p_updated_at < 0 then
    raise exception 'INVALID_PROJECTION';
  end if;

  insert into event_states (event_id, updated_at)
    values (p_event_id, p_updated_at)
    on conflict (event_id) do nothing;
  select * into v_state from event_states where event_id = p_event_id for update;

  update event_states
    set catalog_payload = case when p_projection = 'cashier-catalog' then p_payload else v_state.catalog_payload end,
        mobile_context = case when p_projection = 'mobile-context' then p_payload else v_state.mobile_context end,
        version = v_state.version + 1,
        updated_at = greatest(v_state.updated_at, p_updated_at)
    where event_id = p_event_id;

  insert into event_projections (event_id, projection, payload, updated_at)
    values (p_event_id, p_projection, p_payload, p_updated_at)
    on conflict (event_id, projection) do update
      set payload = excluded.payload, updated_at = greatest(event_projections.updated_at, excluded.updated_at);
  return p_payload;
end;
$$;

create or replace function public.gtrz_commit_mobile_state(
  p_event_id text,
  p_command_id text,
  p_type text,
  p_payload jsonb,
  p_catalog jsonb,
  p_context jsonb,
  p_expected_version bigint,
  p_created_at bigint
) returns jsonb
language plpgsql
security definer
set search_path = gtrz, public, pg_temp
as $$
declare
  v_existing jsonb;
  v_state event_states%rowtype;
  v_sequence bigint;
  v_event jsonb;
  v_response jsonb;
begin
  if char_length(trim(p_event_id)) = 0 or char_length(p_event_id) > 160 or
     char_length(trim(p_command_id)) = 0 or char_length(p_command_id) > 160 or
     char_length(trim(p_type)) = 0 or char_length(p_type) > 120 or
     p_payload is null or p_catalog is null or p_context is null or
     p_expected_version < 0 or p_created_at < 0 then
    raise exception 'INVALID_MOBILE_COMMAND';
  end if;

  select response_json into v_existing
    from event_commands
    where event_id = p_event_id and command_id = p_command_id;
  if found then
    return jsonb_build_object('status', 'replayed', 'response', v_existing);
  end if;

  insert into event_states (event_id, updated_at)
    values (p_event_id, p_created_at)
    on conflict (event_id) do nothing;
  select * into v_state from event_states where event_id = p_event_id for update;
  if v_state.version <> p_expected_version then
    return jsonb_build_object('status', 'conflict', 'version', v_state.version);
  end if;

  insert into event_journal (event_id, command_id, type, payload, created_at)
    values (p_event_id, p_command_id, p_type, p_payload, p_created_at)
    returning sequence into v_sequence;
  v_event := jsonb_build_object(
    'sequence', v_sequence,
    'commandId', p_command_id,
    'type', p_type,
    'payload', p_payload,
    'createdAt', p_created_at
  );
  v_response := jsonb_build_object(
    'commandId', p_command_id,
    'event', v_event,
    'result', jsonb_build_object('accepted', true)
  );
  insert into event_commands (event_id, command_id, response_json, created_at)
    values (p_event_id, p_command_id, v_response, p_created_at);
  update event_states
    set catalog_payload = p_catalog,
        mobile_context = p_context,
        version = v_state.version + 1,
        updated_at = greatest(v_state.updated_at, p_created_at)
    where event_id = p_event_id;
  insert into event_projections (event_id, projection, payload, updated_at)
    values
      (p_event_id, 'cashier-catalog', p_catalog, p_created_at),
      (p_event_id, 'mobile-context', p_context, p_created_at)
    on conflict (event_id, projection) do update
      set payload = excluded.payload, updated_at = greatest(event_projections.updated_at, excluded.updated_at);
  return jsonb_build_object('status', 'accepted', 'response', v_response, 'version', v_state.version + 1);
exception
  when unique_violation then
    select response_json into v_existing from event_commands
      where event_id = p_event_id and command_id = p_command_id;
    if found then return jsonb_build_object('status', 'replayed', 'response', v_existing); end if;
    raise;
end;
$$;

create or replace function public.gtrz_set_global_event(
  p_command_id text,
  p_event_id text,
  p_event_name text,
  p_created_at bigint
) returns jsonb
language plpgsql
security definer
set search_path = gtrz, public, pg_temp
as $$
declare
  v_sequence bigint;
begin
  if char_length(trim(p_command_id)) = 0 or char_length(trim(p_event_id)) = 0 or
     char_length(trim(p_event_name)) = 0 or p_created_at < 0 then
    raise exception 'INVALID_GLOBAL_EVENT';
  end if;
  insert into global_commands (command_id, type, event_id, event_name, created_at)
    values (p_command_id, 'event.activated', p_event_id, p_event_name, p_created_at)
    on conflict (command_id) do nothing
    returning sequence into v_sequence;
  if v_sequence is null then
    select sequence into v_sequence from global_commands where command_id = p_command_id;
  end if;
  return jsonb_build_object('sequence', v_sequence);
end;
$$;

create or replace function public.gtrz_read_global_control(p_after bigint default 0)
returns jsonb
language sql
security definer
set search_path = gtrz, public, pg_temp
stable
as $$
  select jsonb_build_object(
    'commands', coalesce(
      (
        select jsonb_agg(jsonb_build_object(
          'sequence', sequence,
          'commandId', command_id,
          'type', type,
          'eventId', event_id,
          'eventName', event_name,
          'reason', reason,
          'bootstrapSnapshotId', null,
          'snapshotSourceDeviceId', null,
          'createdAt', created_at
        ) order by sequence)
        from global_commands
        where sequence > greatest(p_after, 0)
      ), jsonb_build_array()
    ),
    'cursor', coalesce((select max(sequence) from global_commands), 0),
    'pendingReset', null
  );
$$;

revoke all on function public.gtrz_read_event_state(text) from public, anon, authenticated;
revoke all on function public.gtrz_replace_event_projection(text, text, jsonb, bigint) from public, anon, authenticated;
revoke all on function public.gtrz_commit_mobile_state(text, text, text, jsonb, jsonb, jsonb, bigint, bigint) from public, anon, authenticated;
revoke all on function public.gtrz_set_global_event(text, text, text, bigint) from public, anon, authenticated;
revoke all on function public.gtrz_read_global_control(bigint) from public, anon, authenticated;
grant execute on function public.gtrz_read_event_state(text) to service_role;
grant execute on function public.gtrz_replace_event_projection(text, text, jsonb, bigint) to service_role;
grant execute on function public.gtrz_commit_mobile_state(text, text, text, jsonb, jsonb, jsonb, bigint, bigint) to service_role;
grant execute on function public.gtrz_set_global_event(text, text, text, bigint) to service_role;
grant execute on function public.gtrz_read_global_control(bigint) to service_role;
