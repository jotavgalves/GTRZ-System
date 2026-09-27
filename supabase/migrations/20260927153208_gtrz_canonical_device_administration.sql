-- Administration routes use these service-role-only functions so a revoked
-- desktop cannot keep a global reset or a printer queue blocked forever.
create or replace function public.gtrz_list_desktop_devices()
returns jsonb
language sql
security definer
set search_path = gtrz, public, pg_temp
stable
as $$
  select jsonb_build_object(
    'devices', coalesce(jsonb_agg(jsonb_build_object(
      'deviceId', device_id,
      'label', label,
      'createdAt', created_at,
      'lastSeenAt', last_seen_at,
      'revokedAt', revoked_at
    ) order by revoked_at nulls first, last_seen_at desc), '[]'::jsonb)
  ) from desktop_devices;
$$;

create or replace function public.gtrz_revoke_desktop_device(
  p_device_id text,
  p_now bigint
) returns jsonb
language plpgsql
security definer
set search_path = gtrz, public, pg_temp
as $$
declare
  v_reset global_reset_requests%rowtype;
  v_complete boolean;
begin
  if char_length(trim(p_device_id)) = 0 or char_length(p_device_id) > 160 or p_now < 0 then
    raise exception 'INVALID_DEVICE';
  end if;

  update desktop_devices
    set revoked_at = coalesce(revoked_at, p_now)
    where device_id = p_device_id;
  if not found then raise exception 'DEVICE_NOT_FOUND'; end if;

  update print_printers set enabled = false, busy_job_id = null, updated_at = p_now
    where device_id = p_device_id;
  update print_jobs set status = 'uncertain', error = 'Dispositivo revogado durante a impressão.', updated_at = p_now
    where status = 'claimed' and assigned_printer_id in (
      select printer_id from print_printers where device_id = p_device_id
    );

  select * into v_reset from global_reset_requests where status = 'pending' for update;
  if found and v_reset.target_device_ids ? p_device_id then
    update global_reset_requests
      set target_device_ids = coalesce((
        select jsonb_agg(target)
          from jsonb_array_elements_text(v_reset.target_device_ids) target
          where target <> p_device_id
      ), '[]'::jsonb)
      where request_id = v_reset.request_id
      returning * into v_reset;

    select not exists(
      select 1 from jsonb_array_elements_text(v_reset.target_device_ids) target
      where not exists(
        select 1 from global_reset_backups backup
        where backup.request_id = v_reset.request_id and backup.device_id = target
      )
    ) into v_complete;
    if v_complete then
      update global_reset_requests set status = 'completed', completed_at = p_now
        where request_id = v_reset.request_id;
      insert into global_commands (command_id, type, event_id, event_name, reason, created_at)
        values (v_reset.request_id, 'event.reset', v_reset.event_id, v_reset.event_name, v_reset.reason, p_now)
        on conflict (command_id) do nothing;
    end if;
  end if;

  return jsonb_build_object('deviceId', p_device_id, 'revokedAt', p_now);
end;
$$;

revoke all on function public.gtrz_list_desktop_devices() from public, anon, authenticated;
revoke all on function public.gtrz_revoke_desktop_device(text, bigint) from public, anon, authenticated;
grant execute on function public.gtrz_list_desktop_devices() to service_role;
grant execute on function public.gtrz_revoke_desktop_device(text, bigint) to service_role;
