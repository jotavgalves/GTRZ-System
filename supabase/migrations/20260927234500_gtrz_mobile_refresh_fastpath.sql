-- A single round trip for the authenticated mobile projection. The Edge Function
-- remains the only caller because this function is granted only to service_role.
create or replace function public.gtrz_read_mobile_refresh(
  p_token_hash text,
  p_now bigint
) returns jsonb
language plpgsql
security definer
set search_path = gtrz, public, pg_temp
as $$
declare
  v_session record;
  v_event_id text;
  v_catalog jsonb;
  v_context jsonb;
begin
  if p_token_hash !~ '^[a-f0-9]{64}$' or p_now < 0 then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  select
    sessions.session_id,
    sessions.device_id,
    sessions.expires_at,
    sessions.revoked_at,
    operators.operator_id,
    operators.name,
    operators.permissions,
    operators.active
  into v_session
  from mobile_sessions as sessions
  join mobile_operators as operators on operators.operator_id = sessions.operator_id
  where sessions.token_hash = p_token_hash;

  if not found or v_session.revoked_at is not null or v_session.expires_at <= p_now or
     v_session.active is not true then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  select event_id into v_event_id
  from global_commands
  order by sequence desc
  limit 1;
  if v_event_id is null then
    return jsonb_build_object('status', 'no-active-event');
  end if;

  select catalog_payload, mobile_context
  into v_catalog, v_context
  from event_states
  where event_id = v_event_id;

  update mobile_sessions
  set last_seen_at = greatest(last_seen_at, p_now)
  where session_id = v_session.session_id;

  return jsonb_build_object(
    'status', 'ok',
    'operator', jsonb_build_object(
      'id', v_session.operator_id,
      'name', v_session.name,
      'permissions', v_session.permissions
    ),
    'deviceId', v_session.device_id,
    'eventId', v_event_id,
    'catalog', coalesce(v_catalog, jsonb_build_object('products', jsonb_build_array(), 'currentSequence', 0)),
    'context', coalesce(v_context, jsonb_build_object(
      'ticketLots', jsonb_build_array(),
      'servicePoints', jsonb_build_array(),
      'voucherCodes', jsonb_build_array(),
      'vouchers', jsonb_build_array(),
      'currentSequence', 0
    ))
  );
end;
$$;

revoke all on function public.gtrz_read_mobile_refresh(text, bigint) from public, anon, authenticated;
grant execute on function public.gtrz_read_mobile_refresh(text, bigint) to service_role;
