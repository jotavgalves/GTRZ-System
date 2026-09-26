-- GTRZ fallback replica. The Edge Function is the only application role allowed
-- to call the RPCs below; browsers and desktop clients never receive database access.
create schema if not exists gtrz;

revoke all on schema gtrz from public, anon, authenticated;
grant usage on schema gtrz to service_role;

create table if not exists gtrz.event_commands (
  event_id text not null check (char_length(event_id) between 1 and 160),
  command_id text not null check (char_length(command_id) between 1 and 160),
  response_json jsonb not null,
  created_at bigint not null,
  primary key (event_id, command_id)
);

create table if not exists gtrz.event_journal (
  sequence bigint generated always as identity primary key,
  event_id text not null check (char_length(event_id) between 1 and 160),
  command_id text not null check (char_length(command_id) between 1 and 160),
  type text not null check (char_length(type) between 1 and 120),
  payload jsonb not null,
  created_at bigint not null,
  unique (event_id, command_id)
);

create index if not exists event_journal_event_sequence_idx
  on gtrz.event_journal (event_id, sequence);

create table if not exists gtrz.event_projections (
  event_id text not null check (char_length(event_id) between 1 and 160),
  projection text not null check (projection in ('cashier-catalog', 'mobile-context')),
  payload jsonb not null,
  updated_at bigint not null,
  primary key (event_id, projection)
);

alter table gtrz.event_commands enable row level security;
alter table gtrz.event_journal enable row level security;
alter table gtrz.event_projections enable row level security;

revoke all on all tables in schema gtrz from public, anon, authenticated;
grant select, insert, update, delete on all tables in schema gtrz to service_role;

create or replace function public.gtrz_append_journal(
  p_event_id text,
  p_command_id text,
  p_type text,
  p_payload jsonb,
  p_created_at bigint
) returns jsonb
language plpgsql
security definer
set search_path = gtrz, public, pg_temp
as $$
declare
  v_existing jsonb;
  v_sequence bigint;
  v_event jsonb;
  v_response jsonb;
begin
  if char_length(trim(p_event_id)) = 0 or char_length(p_event_id) > 160 then
    raise exception 'INVALID_EVENT_ID';
  end if;
  if char_length(trim(p_command_id)) = 0 or char_length(p_command_id) > 160 then
    raise exception 'INVALID_COMMAND_ID';
  end if;
  if char_length(trim(p_type)) = 0 or char_length(p_type) > 120 then
    raise exception 'INVALID_EVENT_TYPE';
  end if;
  if p_payload is null or p_created_at < 0 then
    raise exception 'INVALID_EVENT_PAYLOAD';
  end if;

  select response_json into v_existing
    from event_commands
    where event_id = p_event_id and command_id = p_command_id;
  if found then
    return v_existing;
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
  return v_response;
exception
  when unique_violation then
    select response_json into v_existing
      from event_commands
      where event_id = p_event_id and command_id = p_command_id;
    if found then return v_existing; end if;
    raise;
end;
$$;

create or replace function public.gtrz_replace_projection(
  p_event_id text,
  p_projection text,
  p_payload jsonb,
  p_updated_at bigint
) returns jsonb
language plpgsql
security definer
set search_path = gtrz, public, pg_temp
as $$
begin
  if char_length(trim(p_event_id)) = 0 or char_length(p_event_id) > 160 then
    raise exception 'INVALID_EVENT_ID';
  end if;
  if p_projection not in ('cashier-catalog', 'mobile-context') then
    raise exception 'INVALID_PROJECTION';
  end if;
  if p_payload is null or p_updated_at < 0 then
    raise exception 'INVALID_PROJECTION_PAYLOAD';
  end if;

  insert into event_projections (event_id, projection, payload, updated_at)
    values (p_event_id, p_projection, p_payload, p_updated_at)
    on conflict (event_id, projection) do update
      set payload = excluded.payload, updated_at = excluded.updated_at;
  return p_payload;
end;
$$;

create or replace function public.gtrz_read_projection(
  p_event_id text,
  p_projection text
) returns jsonb
language sql
security definer
set search_path = gtrz, public, pg_temp
stable
as $$
  select coalesce(
    (select payload from event_projections
      where event_id = p_event_id and projection = p_projection),
    case p_projection
      when 'cashier-catalog' then jsonb_build_object('products', jsonb_build_array(), 'currentSequence', 0)
      when 'mobile-context' then jsonb_build_object(
        'ticketLots', jsonb_build_array(),
        'servicePoints', jsonb_build_array(),
        'voucherCodes', jsonb_build_array(),
        'vouchers', jsonb_build_array(),
        'currentSequence', 0
      )
      else null
    end
  );
$$;

create or replace function public.gtrz_read_journal(
  p_event_id text,
  p_after bigint default 0
) returns jsonb
language sql
security definer
set search_path = gtrz, public, pg_temp
stable
as $$
  select jsonb_build_object(
    'events', coalesce(
      (
        select jsonb_agg(jsonb_build_object(
          'sequence', sequence,
          'commandId', command_id,
          'type', type,
          'payload', payload,
          'createdAt', created_at
        ) order by sequence)
        from (
          select sequence, command_id, type, payload, created_at
          from event_journal
          where event_id = p_event_id and sequence > greatest(p_after, 0)
          order by sequence
          limit 1000
        ) entries
      ),
      jsonb_build_array()
    ),
    'cursor', coalesce(
      (select max(sequence) from event_journal where event_id = p_event_id),
      0
    )
  );
$$;

revoke all on function public.gtrz_append_journal(text, text, text, jsonb, bigint)
  from public, anon, authenticated;
revoke all on function public.gtrz_replace_projection(text, text, jsonb, bigint)
  from public, anon, authenticated;
revoke all on function public.gtrz_read_projection(text, text)
  from public, anon, authenticated;
revoke all on function public.gtrz_read_journal(text, bigint)
  from public, anon, authenticated;
grant execute on function public.gtrz_append_journal(text, text, text, jsonb, bigint) to service_role;
grant execute on function public.gtrz_replace_projection(text, text, jsonb, bigint) to service_role;
grant execute on function public.gtrz_read_projection(text, text) to service_role;
grant execute on function public.gtrz_read_journal(text, bigint) to service_role;
