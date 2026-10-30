-- Operational services that must share the same canonical database as the
-- journal: desktop presence, two-phase event reset and the print queue.
create table if not exists gtrz.desktop_devices (
  device_id text primary key check (char_length(device_id) between 1 and 160),
  label text not null check (char_length(label) between 1 and 120),
  active_event_id text,
  last_seen_at bigint not null check (last_seen_at >= 0),
  created_at bigint not null check (created_at >= 0),
  revoked_at bigint
);

create table if not exists gtrz.global_reset_requests (
  request_id text primary key check (char_length(request_id) between 1 and 160),
  event_id text not null check (char_length(event_id) between 1 and 160),
  event_name text not null check (char_length(event_name) between 1 and 160),
  reason text not null check (char_length(reason) between 1 and 500),
  requested_by_device_id text not null references gtrz.desktop_devices(device_id),
  target_device_ids jsonb not null,
  status text not null check (status in ('pending', 'completed', 'cancelled')),
  created_at bigint not null check (created_at >= 0),
  completed_at bigint
);

create unique index if not exists global_reset_one_pending_idx
  on gtrz.global_reset_requests ((status)) where status = 'pending';

create table if not exists gtrz.global_reset_backups (
  request_id text not null references gtrz.global_reset_requests(request_id) on delete cascade,
  device_id text not null references gtrz.desktop_devices(device_id),
  file_name text not null check (char_length(file_name) between 1 and 240),
  storage_path text not null check (char_length(storage_path) between 1 and 500),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  bytes bigint not null check (bytes >= 0),
  created_at bigint not null check (created_at >= 0),
  primary key (request_id, device_id)
);

create table if not exists gtrz.print_printers (
  printer_id text primary key check (char_length(printer_id) between 1 and 160),
  event_id text not null check (char_length(event_id) between 1 and 160),
  device_id text not null references gtrz.desktop_devices(device_id),
  device_label text not null check (char_length(device_label) between 1 and 120),
  printer_name text not null check (char_length(printer_name) between 1 and 240),
  paper_width_mm integer not null check (paper_width_mm in (58, 80)),
  enabled boolean not null,
  busy_job_id text,
  last_seen_at bigint not null check (last_seen_at >= 0),
  updated_at bigint not null check (updated_at >= 0),
  unique (event_id, device_id, printer_name)
);

create table if not exists gtrz.print_jobs (
  job_id text primary key check (char_length(job_id) between 1 and 160),
  event_id text not null check (char_length(event_id) between 1 and 160),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 240),
  command_id text not null check (char_length(command_id) between 1 and 160),
  order_id text not null check (char_length(order_id) between 1 and 160),
  document_json jsonb not null,
  status text not null check (status in ('queued', 'claimed', 'printed', 'failed', 'uncertain')),
  assigned_printer_id text references gtrz.print_printers(printer_id),
  claim_token text,
  claimed_at bigint,
  printed_at bigint,
  printed_by_device_id text references gtrz.desktop_devices(device_id),
  printed_by_label text,
  attempts integer not null default 0 check (attempts >= 0),
  error text,
  created_at bigint not null check (created_at >= 0),
  updated_at bigint not null check (updated_at >= 0),
  unique (event_id, idempotency_key)
);

create index if not exists print_jobs_event_queue_idx
  on gtrz.print_jobs (event_id, status, created_at);

create table if not exists gtrz.print_attempts (
  attempt_id text primary key check (char_length(attempt_id) between 1 and 160),
  job_id text not null references gtrz.print_jobs(job_id) on delete cascade,
  printer_id text not null references gtrz.print_printers(printer_id),
  device_id text not null references gtrz.desktop_devices(device_id),
  result text not null check (result in ('claimed', 'printed', 'failed', 'uncertain')),
  error text,
  created_at bigint not null check (created_at >= 0)
);

create table if not exists gtrz.print_counters (
  event_id text primary key,
  next_number bigint not null check (next_number >= 1)
);

alter table gtrz.desktop_devices enable row level security;
alter table gtrz.global_reset_requests enable row level security;
alter table gtrz.global_reset_backups enable row level security;
alter table gtrz.print_printers enable row level security;
alter table gtrz.print_jobs enable row level security;
alter table gtrz.print_attempts enable row level security;
alter table gtrz.print_counters enable row level security;
revoke all on all tables in schema gtrz from public, anon, authenticated;
grant select, insert, update, delete on all tables in schema gtrz to service_role;

-- Backups are private and uploaded only by the Edge Function using service_role.
insert into storage.buckets (id, name, public, file_size_limit)
values ('gtrz-reset-backups', 'gtrz-reset-backups', false, 104857600)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

create or replace function public.gtrz_replace_event_projection_checked(
  p_event_id text,
  p_projection text,
  p_payload jsonb,
  p_expected_version bigint,
  p_updated_at bigint
) returns jsonb
language plpgsql
security definer
set search_path = gtrz, public, pg_temp
as $$
declare
  v_state event_states%rowtype;
begin
  if char_length(trim(p_event_id)) = 0 or char_length(p_event_id) > 160 or
     p_projection not in ('cashier-catalog', 'mobile-context') or p_payload is null or
     p_expected_version < 0 or p_updated_at < 0 then
    raise exception 'INVALID_PROJECTION';
  end if;
  insert into event_states (event_id, updated_at)
    values (p_event_id, p_updated_at) on conflict (event_id) do nothing;
  select * into v_state from event_states where event_id = p_event_id for update;
  if v_state.version <> p_expected_version then
    return jsonb_build_object('status', 'conflict', 'version', v_state.version);
  end if;
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
  return jsonb_build_object('status', 'accepted', 'version', v_state.version + 1);
end;
$$;

create or replace function public.gtrz_register_desktop_device(
  p_device_id text,
  p_label text,
  p_active_event_id text,
  p_seen_at bigint
) returns jsonb
language plpgsql
security definer
set search_path = gtrz, public, pg_temp
as $$
begin
  if char_length(trim(p_device_id)) = 0 or char_length(p_device_id) > 160 or
     char_length(trim(p_label)) = 0 or char_length(p_label) > 120 or p_seen_at < 0 then
    raise exception 'INVALID_DEVICE';
  end if;
  insert into desktop_devices (device_id, label, active_event_id, last_seen_at, created_at, revoked_at)
    values (p_device_id, p_label, nullif(trim(p_active_event_id), ''), p_seen_at, p_seen_at, null)
    on conflict (device_id) do update
      set label = excluded.label,
          active_event_id = excluded.active_event_id,
          last_seen_at = excluded.last_seen_at
      where desktop_devices.revoked_at is null;
  if not found then raise exception 'DEVICE_REVOKED'; end if;
  return jsonb_build_object('deviceId', p_device_id, 'label', p_label, 'lastSeenAt', p_seen_at);
end;
$$;

create or replace function public.gtrz_request_global_reset(
  p_request_id text,
  p_event_id text,
  p_event_name text,
  p_reason text,
  p_device_id text,
  p_created_at bigint
) returns jsonb
language plpgsql
security definer
set search_path = gtrz, public, pg_temp
as $$
declare
  v_targets jsonb;
  v_existing global_reset_requests%rowtype;
begin
  if char_length(trim(p_request_id)) = 0 or char_length(trim(p_event_id)) = 0 or
     char_length(trim(p_event_name)) = 0 or char_length(trim(p_reason)) = 0 or p_created_at < 0 then
    raise exception 'INVALID_RESET_REQUEST';
  end if;
  select * into v_existing from global_reset_requests where status = 'pending' for update;
  if found then
    if v_existing.event_id <> p_event_id then raise exception 'RESET_ALREADY_PENDING'; end if;
    return jsonb_build_object('requestId', v_existing.request_id, 'status', v_existing.status);
  end if;
  if not exists(select 1 from desktop_devices where device_id = p_device_id and revoked_at is null) then
    raise exception 'DEVICE_NOT_REGISTERED';
  end if;
  select coalesce(jsonb_agg(device_id order by device_id), '[]'::jsonb) into v_targets
    from desktop_devices where revoked_at is null;
  insert into global_reset_requests
    (request_id, event_id, event_name, reason, requested_by_device_id, target_device_ids, status, created_at)
    values (p_request_id, p_event_id, p_event_name, p_reason, p_device_id, v_targets, 'pending', p_created_at);
  return jsonb_build_object('requestId', p_request_id, 'status', 'pending', 'targetDeviceIds', v_targets);
end;
$$;

create or replace function public.gtrz_complete_reset_backup(
  p_request_id text,
  p_device_id text,
  p_file_name text,
  p_storage_path text,
  p_sha256 text,
  p_bytes bigint,
  p_created_at bigint
) returns jsonb
language plpgsql
security definer
set search_path = gtrz, public, pg_temp
as $$
declare
  v_request global_reset_requests%rowtype;
  v_complete boolean;
begin
  select * into v_request from global_reset_requests where request_id = p_request_id for update;
  if not found or v_request.status <> 'pending' then raise exception 'RESET_NOT_PENDING'; end if;
  if not exists(select 1 from jsonb_array_elements_text(v_request.target_device_ids) target where target = p_device_id) then
    raise exception 'DEVICE_NOT_TARGETED';
  end if;
  insert into global_reset_backups (request_id, device_id, file_name, storage_path, sha256, bytes, created_at)
    values (p_request_id, p_device_id, p_file_name, p_storage_path, lower(p_sha256), p_bytes, p_created_at)
    on conflict (request_id, device_id) do nothing;
  select not exists(
    select 1 from jsonb_array_elements_text(v_request.target_device_ids) target
    where not exists(select 1 from global_reset_backups backup where backup.request_id = p_request_id and backup.device_id = target)
  ) into v_complete;
  if v_complete then
    update global_reset_requests set status = 'completed', completed_at = p_created_at where request_id = p_request_id;
    insert into global_commands (command_id, type, event_id, event_name, reason, created_at)
      values (p_request_id, 'event.reset', v_request.event_id, v_request.event_name, v_request.reason, p_created_at)
      on conflict (command_id) do nothing;
  end if;
  return jsonb_build_object('complete', v_complete, 'requestId', p_request_id);
end;
$$;

create or replace function public.gtrz_enqueue_print_job(
  p_event_id text,
  p_command_id text,
  p_idempotency_key text,
  p_order_id text,
  p_document jsonb,
  p_created_at bigint
) returns jsonb
language plpgsql
security definer
set search_path = gtrz, public, pg_temp
as $$
declare
  v_job print_jobs%rowtype;
  v_number bigint;
  v_reference text;
begin
  select * into v_job from print_jobs where event_id = p_event_id and idempotency_key = p_idempotency_key;
  if found then return jsonb_build_object('jobId', v_job.job_id, 'status', v_job.status, 'replayed', true); end if;
  insert into print_counters (event_id, next_number) values (p_event_id, 1)
    on conflict (event_id) do nothing;
  update print_counters set next_number = next_number + 1 where event_id = p_event_id returning next_number - 1 into v_number;
  v_reference := upper(left(p_event_id, 8)) || '-' || lpad(v_number::text, 4, '0');
  insert into print_jobs
    (job_id, event_id, idempotency_key, command_id, order_id, document_json, status, attempts, created_at, updated_at)
    values (md5(random()::text || clock_timestamp()::text || txid_current()::text), p_event_id,
      p_idempotency_key, p_command_id, p_order_id,
      p_document || jsonb_build_object('referenceCode', coalesce(p_document->>'referenceCode', v_reference)),
      'queued', 0, p_created_at, p_created_at)
    returning * into v_job;
  return jsonb_build_object('jobId', v_job.job_id, 'status', v_job.status, 'replayed', false);
end;
$$;

create or replace function public.gtrz_register_print_printer(
  p_event_id text, p_device_id text, p_device_label text, p_printer_name text,
  p_paper_width_mm integer, p_enabled boolean, p_seen_at bigint
) returns jsonb
language plpgsql
security definer
set search_path = gtrz, public, pg_temp
as $$
declare v_printer print_printers%rowtype;
begin
  if p_paper_width_mm not in (58, 80) then raise exception 'INVALID_PRINTER'; end if;
  if not exists(select 1 from desktop_devices where device_id = p_device_id and revoked_at is null) then raise exception 'DEVICE_NOT_REGISTERED'; end if;
  insert into print_printers
    (printer_id, event_id, device_id, device_label, printer_name, paper_width_mm, enabled, busy_job_id, last_seen_at, updated_at)
    values (md5(random()::text || clock_timestamp()::text), p_event_id, p_device_id, p_device_label, p_printer_name,
      p_paper_width_mm, p_enabled, null, p_seen_at, p_seen_at)
    on conflict (event_id, device_id, printer_name) do update set
      device_label = excluded.device_label, paper_width_mm = excluded.paper_width_mm,
      enabled = excluded.enabled, last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at
    returning * into v_printer;
  return jsonb_build_object('printerId', v_printer.printer_id, 'registeredAt', p_seen_at, 'enabled', v_printer.enabled);
end;
$$;

create or replace function public.gtrz_claim_print_job(p_event_id text, p_device_id text, p_now bigint)
returns jsonb
language plpgsql
security definer
set search_path = gtrz, public, pg_temp
as $$
declare
  v_printer print_printers%rowtype;
  v_job print_jobs%rowtype;
  v_token text;
begin
  select * into v_printer from print_printers
    where event_id = p_event_id and device_id = p_device_id and enabled and busy_job_id is null
    order by last_seen_at desc limit 1 for update skip locked;
  if not found then return jsonb_build_object('job', null); end if;
  select * into v_job from print_jobs where event_id = p_event_id and status = 'queued'
    order by created_at limit 1 for update skip locked;
  if not found then return jsonb_build_object('job', null); end if;
  v_token := md5(random()::text || clock_timestamp()::text || txid_current()::text);
  update print_jobs set status = 'claimed', assigned_printer_id = v_printer.printer_id, claim_token = v_token,
    claimed_at = p_now, attempts = attempts + 1, updated_at = p_now where job_id = v_job.job_id;
  update print_printers set busy_job_id = v_job.job_id, updated_at = p_now where printer_id = v_printer.printer_id;
  insert into print_attempts (attempt_id, job_id, printer_id, device_id, result, error, created_at)
    values (md5(random()::text || clock_timestamp()::text), v_job.job_id, v_printer.printer_id, p_device_id, 'claimed', null, p_now);
  return jsonb_build_object('job', jsonb_build_object('jobId', v_job.job_id, 'claimToken', v_token,
    'printerLabel', v_printer.device_label, 'document', v_job.document_json));
end;
$$;

create or replace function public.gtrz_complete_print_job(
  p_job_id text, p_claim_token text, p_device_id text, p_result text, p_error text, p_now bigint
) returns jsonb
language plpgsql
security definer
set search_path = gtrz, public, pg_temp
as $$
declare v_job print_jobs%rowtype;
begin
  if p_result not in ('printed', 'failed', 'uncertain') then raise exception 'INVALID_PRINT_RESULT'; end if;
  select * into v_job from print_jobs
    where job_id = p_job_id and claim_token = p_claim_token and status = 'claimed' for update;
  if not found or v_job.assigned_printer_id is null then raise exception 'PRINT_CLAIM_INVALID'; end if;
  update print_jobs set status = p_result, printed_at = case when p_result = 'printed' then p_now else null end,
    printed_by_device_id = p_device_id,
    printed_by_label = (select device_label from print_printers where printer_id = v_job.assigned_printer_id),
    error = p_error, updated_at = p_now where job_id = p_job_id;
  update print_printers set busy_job_id = null, updated_at = p_now where printer_id = v_job.assigned_printer_id;
  insert into print_attempts (attempt_id, job_id, printer_id, device_id, result, error, created_at)
    values (md5(random()::text || clock_timestamp()::text), p_job_id, v_job.assigned_printer_id, p_device_id, p_result, p_error, p_now);
  return jsonb_build_object('success', true);
end;
$$;

create or replace function public.gtrz_list_print_jobs(p_event_id text)
returns jsonb
language sql
security definer
set search_path = gtrz, public, pg_temp
stable
as $$
  select jsonb_build_object('jobs', coalesce(jsonb_agg(jsonb_build_object(
    'jobId', job_id, 'commandId', command_id, 'orderId', order_id, 'document', document_json,
    'status', status, 'printedByLabel', printed_by_label, 'attempts', attempts, 'error', error,
    'createdAt', created_at, 'claimedAt', claimed_at, 'printedAt', printed_at
  ) order by created_at desc), '[]'::jsonb)) from print_jobs where event_id = p_event_id;
$$;

create or replace function public.gtrz_read_global_control(p_after bigint default 0)
returns jsonb
language sql
security definer
set search_path = gtrz, public, pg_temp
stable
as $$
  select jsonb_build_object(
    'commands', coalesce((select jsonb_agg(jsonb_build_object(
      'sequence', sequence, 'commandId', command_id, 'type', type, 'eventId', event_id,
      'eventName', event_name, 'reason', reason, 'bootstrapSnapshotId', null,
      'snapshotSourceDeviceId', null, 'createdAt', created_at
    ) order by sequence) from global_commands where sequence > greatest(p_after, 0)), '[]'::jsonb),
    'cursor', coalesce((select max(sequence) from global_commands), 0),
    'pendingReset', (select jsonb_build_object('requestId', request_id, 'eventId', event_id,
      'eventName', event_name, 'reason', reason, 'targetDeviceIds', target_device_ids)
      from global_reset_requests where status = 'pending' order by created_at desc limit 1)
  );
$$;

revoke all on function public.gtrz_replace_event_projection_checked(text, text, jsonb, bigint, bigint) from public, anon, authenticated;
revoke all on function public.gtrz_register_desktop_device(text, text, text, bigint) from public, anon, authenticated;
revoke all on function public.gtrz_request_global_reset(text, text, text, text, text, bigint) from public, anon, authenticated;
revoke all on function public.gtrz_complete_reset_backup(text, text, text, text, text, bigint, bigint) from public, anon, authenticated;
revoke all on function public.gtrz_enqueue_print_job(text, text, text, text, jsonb, bigint) from public, anon, authenticated;
revoke all on function public.gtrz_register_print_printer(text, text, text, text, integer, boolean, bigint) from public, anon, authenticated;
revoke all on function public.gtrz_claim_print_job(text, text, bigint) from public, anon, authenticated;
revoke all on function public.gtrz_complete_print_job(text, text, text, text, text, bigint) from public, anon, authenticated;
revoke all on function public.gtrz_list_print_jobs(text) from public, anon, authenticated;
grant execute on function public.gtrz_replace_event_projection_checked(text, text, jsonb, bigint, bigint) to service_role;
grant execute on function public.gtrz_register_desktop_device(text, text, text, bigint) to service_role;
grant execute on function public.gtrz_request_global_reset(text, text, text, text, text, bigint) to service_role;
grant execute on function public.gtrz_complete_reset_backup(text, text, text, text, text, bigint, bigint) to service_role;
grant execute on function public.gtrz_enqueue_print_job(text, text, text, text, jsonb, bigint) to service_role;
grant execute on function public.gtrz_register_print_printer(text, text, text, text, integer, boolean, bigint) to service_role;
grant execute on function public.gtrz_claim_print_job(text, text, bigint) to service_role;
grant execute on function public.gtrz_complete_print_job(text, text, text, text, text, bigint) to service_role;
grant execute on function public.gtrz_list_print_jobs(text) to service_role;
