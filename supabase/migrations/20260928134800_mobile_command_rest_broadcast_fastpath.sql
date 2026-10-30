-- Delivery is intentionally outside the database transaction. Database
-- Broadcast is written through realtime.messages and reaches subscribers by
-- WAL replication, which is reliable but too slow for the sales dashboard's
-- immediate-feedback path. The Edge Function starts a REST Broadcast only
-- after this authoritative commit succeeds; the journal remains the source of
-- truth and the desktop's reconciliation path still recovers a missed signal.
create or replace function public.gtrz_commit_mobile_state_fast(
  p_event_id text,
  p_command_id text,
  p_type text,
  p_payload jsonb,
  p_catalog jsonb,
  p_context jsonb,
  p_expected_version bigint,
  p_created_at bigint,
  p_desktop_realtime_topic text
) returns jsonb
language plpgsql
security definer
set search_path = gtrz, public, pg_temp
as $$
begin
  -- Retained only for rolling-deploy compatibility with installed clients.
  -- The Edge Function owns the low-latency delivery over Realtime REST.
  return public.gtrz_commit_mobile_state(
    p_event_id,
    p_command_id,
    p_type,
    p_payload,
    p_catalog,
    p_context,
    p_expected_version,
    p_created_at
  );
end;
$$;

revoke all on function public.gtrz_commit_mobile_state_fast(text, text, text, jsonb, jsonb, jsonb, bigint, bigint, text)
  from public, anon, authenticated;
grant execute on function public.gtrz_commit_mobile_state_fast(text, text, text, jsonb, jsonb, jsonb, bigint, bigint, text)
  to service_role;
