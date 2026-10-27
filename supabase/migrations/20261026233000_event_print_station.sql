-- Each event has one explicit print station. A job stays queued when that
-- station is offline or has no eligible physical printer; another PC cannot
-- silently take over and risk a duplicate physical receipt.
create table if not exists gtrz.event_print_stations (
  event_id text primary key,
  device_id text not null references gtrz.desktop_devices(device_id),
  updated_at bigint not null
);

alter table gtrz.event_print_stations enable row level security;
revoke all on gtrz.event_print_stations from public, anon, authenticated;
grant select, insert, update, delete on gtrz.event_print_stations to service_role;

create or replace function public.gtrz_get_event_print_station(p_event_id text)
returns jsonb language sql security definer
set search_path = gtrz, public, pg_temp stable as $$
  select jsonb_build_object(
    'eventId', p_event_id,
    'deviceId', (select device_id from event_print_stations where event_id = p_event_id),
    'printers', coalesce((select jsonb_agg(jsonb_build_object(
      'deviceId', p.device_id, 'deviceLabel', p.device_label,
      'printerName', p.printer_name, 'enabled', p.enabled,
      'lastSeenAt', p.last_seen_at, 'busyJobId', p.busy_job_id
    ) order by p.last_seen_at desc) from print_printers p where p.event_id = p_event_id), '[]'::jsonb),
    'queued', (select count(*) from print_jobs where event_id = p_event_id and status = 'queued'),
    'needsAttention', (select count(*) from print_jobs where event_id = p_event_id and status in ('failed','uncertain','claimed'))
  );
$$;

create or replace function public.gtrz_set_event_print_station(
  p_event_id text, p_device_id text, p_now bigint
) returns jsonb language plpgsql security definer
set search_path = gtrz, public, pg_temp as $$
begin
  if length(trim(p_event_id)) = 0 or p_now < 0 then raise exception 'INVALID_EVENT'; end if;
  if p_device_id is null then
    delete from event_print_stations where event_id = p_event_id;
  else
    if not exists(select 1 from desktop_devices where device_id = p_device_id and revoked_at is null)
      then raise exception 'DEVICE_NOT_AVAILABLE'; end if;
    insert into event_print_stations(event_id, device_id, updated_at)
      values(p_event_id, p_device_id, p_now)
      on conflict(event_id) do update set device_id = excluded.device_id, updated_at = excluded.updated_at;
  end if;
  return public.gtrz_get_event_print_station(p_event_id);
end;
$$;

create or replace function public.gtrz_claim_print_job(p_event_id text, p_device_id text, p_now bigint)
returns jsonb language plpgsql security definer
set search_path = gtrz, public, pg_temp as $$
declare v_printer print_printers%rowtype; v_job print_jobs%rowtype; v_token text;
begin
  -- Require an explicit route and a live desktop on the same event.
  if not exists (
    select 1 from event_print_stations s join desktop_devices d on d.device_id = s.device_id
    where s.event_id = p_event_id and s.device_id = p_device_id
      and d.revoked_at is null and d.active_event_id = p_event_id
      and d.last_seen_at >= p_now - 30000
  ) then return jsonb_build_object('job', null); end if;
  -- A crashed agent must not lock its printer forever. Its old job becomes
  -- uncertain, never queued again automatically, because paper may have left
  -- the printer before the acknowledgement was lost.
  update print_jobs set status = 'uncertain', error = 'Impressão sem confirmação após cinco minutos.',
    updated_at = p_now
    where event_id = p_event_id and status = 'claimed' and claimed_at < p_now - 300000
      and assigned_printer_id in (select printer_id from print_printers where device_id = p_device_id);
  update print_printers p set busy_job_id = null, updated_at = p_now
    where p.event_id = p_event_id and p.device_id = p_device_id and p.busy_job_id is not null
      and not exists (select 1 from print_jobs j where j.job_id = p.busy_job_id and j.status = 'claimed');
  select * into v_printer from print_printers
    where event_id = p_event_id and device_id = p_device_id and enabled
      and busy_job_id is null and last_seen_at >= p_now - 30000
    order by last_seen_at desc limit 1 for update skip locked;
  if not found then return jsonb_build_object('job', null); end if;
  select * into v_job from print_jobs where event_id = p_event_id and status = 'queued'
    order by created_at limit 1 for update skip locked;
  if not found then return jsonb_build_object('job', null); end if;
  v_token := md5(random()::text || clock_timestamp()::text || txid_current()::text);
  update print_jobs set status = 'claimed', assigned_printer_id = v_printer.printer_id,
    claim_token = v_token, claimed_at = p_now, attempts = attempts + 1, updated_at = p_now
    where job_id = v_job.job_id;
  update print_printers set busy_job_id = v_job.job_id, updated_at = p_now where printer_id = v_printer.printer_id;
  insert into print_attempts(attempt_id, job_id, printer_id, device_id, result, error, created_at)
    values(md5(random()::text || clock_timestamp()::text), v_job.job_id,
      v_printer.printer_id, p_device_id, 'claimed', null, p_now);
  return jsonb_build_object('job', jsonb_build_object('jobId', v_job.job_id,
    'claimToken', v_token, 'printerLabel', v_printer.device_label, 'document', v_job.document_json));
end;
$$;

revoke all on function public.gtrz_get_event_print_station(text) from public, anon, authenticated;
revoke all on function public.gtrz_set_event_print_station(text, text, bigint) from public, anon, authenticated;
revoke all on function public.gtrz_claim_print_job(text, text, bigint) from public, anon, authenticated;
grant execute on function public.gtrz_get_event_print_station(text) to service_role;
grant execute on function public.gtrz_set_event_print_station(text, text, bigint) to service_role;
grant execute on function public.gtrz_claim_print_job(text, text, bigint) to service_role;
