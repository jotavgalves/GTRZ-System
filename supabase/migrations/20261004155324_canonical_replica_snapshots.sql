-- A new desktop must rebuild from a cloud-owned SQLite snapshot, never from
-- another computer's file system. The incremental journal then brings that
-- verified baseline forward without duplicating operations.
create table if not exists gtrz.replica_snapshots (
  snapshot_id text primary key check (char_length(snapshot_id) between 1 and 160),
  event_id text not null check (char_length(event_id) between 1 and 160),
  source_device_id text not null references gtrz.desktop_devices(device_id),
  storage_path text not null unique check (char_length(storage_path) between 1 and 500),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 52428800),
  created_at bigint not null check (created_at >= 0)
);

create index if not exists replica_snapshots_event_created_idx
  on gtrz.replica_snapshots (event_id, created_at desc);

alter table gtrz.global_commands
  add column if not exists bootstrap_snapshot_id text,
  add column if not exists snapshot_source_device_id text;

alter table gtrz.replica_snapshots enable row level security;
revoke all on gtrz.replica_snapshots from public, anon, authenticated;
grant select, insert, update, delete on gtrz.replica_snapshots to service_role;

insert into storage.buckets (id, name, public, file_size_limit)
values ('gtrz-replica-snapshots', 'gtrz-replica-snapshots', false, 52428800)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit;

create or replace function public.gtrz_record_replica_snapshot(
  p_snapshot_id text,
  p_event_id text,
  p_source_device_id text,
  p_storage_path text,
  p_sha256 text,
  p_size_bytes bigint,
  p_created_at bigint
) returns jsonb
language plpgsql
security definer
set search_path = gtrz, public, pg_temp
as $$
begin
  if char_length(trim(p_snapshot_id)) = 0 or char_length(p_snapshot_id) > 160 or
     char_length(trim(p_event_id)) = 0 or char_length(p_event_id) > 160 or
     char_length(trim(p_source_device_id)) = 0 or char_length(p_source_device_id) > 160 or
     char_length(trim(p_storage_path)) = 0 or char_length(p_storage_path) > 500 or
     p_sha256 !~ '^[a-f0-9]{64}$' or p_size_bytes <= 0 or p_size_bytes > 52428800 or
     p_created_at < 0 then
    raise exception 'INVALID_REPLICA_SNAPSHOT';
  end if;
  if not exists (
    select 1 from desktop_devices
    where device_id = p_source_device_id and revoked_at is null
  ) then
    raise exception 'SNAPSHOT_SOURCE_NOT_AUTHORIZED';
  end if;

  insert into replica_snapshots
    (snapshot_id, event_id, source_device_id, storage_path, sha256, size_bytes, created_at)
  values
    (p_snapshot_id, p_event_id, p_source_device_id, p_storage_path, p_sha256, p_size_bytes, p_created_at);

  return jsonb_build_object(
    'snapshotId', p_snapshot_id,
    'eventId', p_event_id,
    'sourceDeviceId', p_source_device_id,
    'sha256', p_sha256,
    'sizeBytes', p_size_bytes,
    'createdAt', p_created_at
  );
end;
$$;

create or replace function public.gtrz_read_replica_snapshot(p_snapshot_id text)
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
        'storagePath', storage_path,
        'sha256', sha256,
        'sizeBytes', size_bytes,
        'createdAt', created_at
      )
      from replica_snapshots
      where snapshot_id = p_snapshot_id
    ),
    'null'::jsonb
  );
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
  v_snapshot replica_snapshots%rowtype;
begin
  if char_length(trim(p_command_id)) = 0 or char_length(trim(p_event_id)) = 0 or
     char_length(trim(p_event_name)) = 0 or p_created_at < 0 then
    raise exception 'INVALID_GLOBAL_EVENT';
  end if;

  select * into v_snapshot
    from replica_snapshots
    where event_id = p_event_id
    order by created_at desc
    limit 1;
  if not found then
    raise exception 'BOOTSTRAP_SNAPSHOT_REQUIRED';
  end if;

  insert into global_commands
    (command_id, type, event_id, event_name, bootstrap_snapshot_id, snapshot_source_device_id, created_at)
  values
    (p_command_id, 'event.activated', p_event_id, p_event_name,
     v_snapshot.snapshot_id, v_snapshot.source_device_id, p_created_at)
  on conflict (command_id) do nothing
  returning sequence into v_sequence;
  if v_sequence is null then
    select sequence into v_sequence from global_commands where command_id = p_command_id;
  end if;
  return jsonb_build_object(
    'sequence', v_sequence,
    'bootstrapSnapshotId', v_snapshot.snapshot_id,
    'snapshotSourceDeviceId', v_snapshot.source_device_id
  );
end;
$$;

create or replace function public.gtrz_read_global_control(p_after bigint default 0)
returns jsonb
language sql
security definer
set search_path = gtrz, public, pg_temp
stable
as $$
  with latest_activation as (
    select max(sequence) as sequence
    from global_commands
    where type = 'event.activated'
  ), commands as (
    select *
    from global_commands
    where sequence > greatest(p_after, 0)
      and (
        p_after > 0 or sequence >= coalesce((select sequence from latest_activation), 0)
      )
  )
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
          'bootstrapSnapshotId', bootstrap_snapshot_id,
          'snapshotSourceDeviceId', snapshot_source_device_id,
          'createdAt', created_at
        ) order by sequence)
        from commands
      ), jsonb_build_array()
    ),
    'cursor', coalesce((select max(sequence) from global_commands), 0),
    'pendingReset', null
  );
$$;

revoke all on function public.gtrz_record_replica_snapshot(text, text, text, text, text, bigint, bigint)
  from public, anon, authenticated;
revoke all on function public.gtrz_read_replica_snapshot(text)
  from public, anon, authenticated;
revoke all on function public.gtrz_set_global_event(text, text, text, bigint)
  from public, anon, authenticated;
revoke all on function public.gtrz_read_global_control(bigint)
  from public, anon, authenticated;
grant execute on function public.gtrz_record_replica_snapshot(text, text, text, text, text, bigint, bigint)
  to service_role;
grant execute on function public.gtrz_read_replica_snapshot(text) to service_role;
grant execute on function public.gtrz_set_global_event(text, text, text, bigint) to service_role;
grant execute on function public.gtrz_read_global_control(bigint) to service_role;
