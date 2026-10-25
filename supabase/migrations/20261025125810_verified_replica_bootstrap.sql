alter table gtrz.replica_snapshots
  add column if not exists verified boolean not null default false,
  add column if not exists catalog_cursor bigint not null default 0,
  add column if not exists event_cursor bigint not null default 0,
  add column if not exists control_cursor bigint not null default 0;

create index if not exists replica_snapshots_verified_event_idx
  on gtrz.replica_snapshots (event_id, created_at desc)
  where verified = true;

create or replace function public.gtrz_record_verified_replica_snapshot(
  p_snapshot_id text,
  p_event_id text,
  p_source_device_id text,
  p_storage_path text,
  p_sha256 text,
  p_size_bytes bigint,
  p_created_at bigint,
  p_catalog_cursor bigint,
  p_event_cursor bigint,
  p_control_cursor bigint
) returns jsonb
language plpgsql
security definer
set search_path = gtrz, public, pg_temp
as $$
declare
  v_catalog_cursor bigint;
  v_event_cursor bigint;
  v_control_cursor bigint;
begin
  if p_catalog_cursor < 0 or p_event_cursor < 0 or p_control_cursor < 0 then
    raise exception 'INVALID_REPLICA_CURSOR';
  end if;

  select coalesce(max(sequence), 0) into v_catalog_cursor
    from event_journal where event_id = '_catalog';
  select coalesce(max(sequence), 0) into v_event_cursor
    from event_journal where event_id = p_event_id;
  select coalesce(max(sequence), 0) into v_control_cursor
    from global_commands;
  if p_catalog_cursor <> v_catalog_cursor or
     p_event_cursor <> v_event_cursor or
     p_control_cursor <> v_control_cursor then
    raise exception 'REPLICA_CURSOR_STALE';
  end if;

  perform public.gtrz_record_replica_snapshot(
    p_snapshot_id, p_event_id, p_source_device_id, p_storage_path,
    p_sha256, p_size_bytes, p_created_at
  );
  update replica_snapshots
    set verified = true,
        catalog_cursor = p_catalog_cursor,
        event_cursor = p_event_cursor,
        control_cursor = p_control_cursor
    where snapshot_id = p_snapshot_id;

  return jsonb_build_object(
    'snapshotId', p_snapshot_id,
    'eventId', p_event_id,
    'sourceDeviceId', p_source_device_id,
    'sha256', p_sha256,
    'sizeBytes', p_size_bytes,
    'catalogCursor', p_catalog_cursor,
    'eventCursor', p_event_cursor,
    'controlCursor', p_control_cursor,
    'createdAt', p_created_at
  );
end;
$$;

create or replace function public.gtrz_read_latest_verified_replica_snapshot(p_event_id text)
returns jsonb
language sql
security definer
set search_path = gtrz, public, pg_temp
stable
as $$
  select coalesce(
    (
      select jsonb_build_object(
        'snapshotId', snapshot_id,
        'eventId', event_id,
        'sourceDeviceId', source_device_id,
        'sha256', sha256,
        'sizeBytes', size_bytes,
        'catalogCursor', catalog_cursor,
        'eventCursor', event_cursor,
        'controlCursor', control_cursor,
        'createdAt', created_at
      )
      from replica_snapshots
      where event_id = p_event_id
        and verified = true
        and control_cursor >= coalesce(
          (select max(sequence) from global_commands
           where event_id = p_event_id and type = 'event.reset'), 0
        )
      order by created_at desc, snapshot_id desc
      limit 1
    ),
    'null'::jsonb
  );
$$;

revoke all on function public.gtrz_record_verified_replica_snapshot(
  text, text, text, text, text, bigint, bigint, bigint, bigint, bigint
) from public, anon, authenticated;
revoke all on function public.gtrz_read_latest_verified_replica_snapshot(text)
  from public, anon, authenticated;
grant execute on function public.gtrz_record_verified_replica_snapshot(
  text, text, text, text, text, bigint, bigint, bigint, bigint, bigint
) to service_role;
grant execute on function public.gtrz_read_latest_verified_replica_snapshot(text)
  to service_role;
