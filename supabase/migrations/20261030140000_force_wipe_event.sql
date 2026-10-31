-- Forced wipe of ONE event's data in the canonical cloud, for the owner only.
--
-- The two-phase reset (gtrz_request_global_reset) waits for a backup from every non-revoked desktop
-- and only records an `event.reset` command: it never deletes the event journal, projections, state
-- or print queue. A stale device therefore blocks it forever, and even a finished reset leaves the
-- journal that desktops replay to rebuild the sales they just cleared.
--
-- This function deletes that data for real. It is called only by the Edge Function (service_role)
-- after the owner login, defaults to a dry run in the Edge Function, refuses the shared catalogue
-- journal and writes an audit row. Storage objects (replica snapshots) are removed by the caller from
-- the paths this function returns.
create table if not exists gtrz.admin_wipe_log (
  wipe_id text primary key check (char_length(wipe_id) between 1 and 160),
  event_id text not null check (char_length(event_id) between 1 and 160),
  event_name text not null check (char_length(event_name) between 1 and 160),
  reason text not null check (char_length(reason) between 3 and 500),
  actor text not null check (char_length(actor) between 1 and 320),
  counts jsonb not null,
  created_at bigint not null check (created_at >= 0)
);

alter table gtrz.admin_wipe_log enable row level security;
revoke all on gtrz.admin_wipe_log from public, anon, authenticated;
grant select, insert, update, delete on gtrz.admin_wipe_log to service_role;

create or replace function public.gtrz_force_wipe_event(
  p_wipe_id text,
  p_event_id text,
  p_event_name text,
  p_reason text,
  p_actor text,
  p_dry_run boolean,
  p_now bigint
) returns jsonb
language plpgsql
security definer
set search_path = gtrz, public, pg_temp
as $$
declare
  v_counts jsonb;
  v_paths jsonb;
begin
  if char_length(trim(coalesce(p_wipe_id, ''))) = 0
     or char_length(trim(coalesce(p_event_id, ''))) = 0
     or char_length(trim(coalesce(p_event_name, ''))) = 0
     or char_length(trim(coalesce(p_reason, ''))) < 3
     or char_length(trim(coalesce(p_actor, ''))) = 0
     or p_dry_run is null
     or p_now is null or p_now < 0 then
    raise exception 'INVALID_FORCE_WIPE';
  end if;
  -- The shared catalogue journal is not an event: wiping it would erase every product.
  if p_event_id = '_catalog' then
    raise exception 'PROTECTED_EVENT';
  end if;

  v_counts := jsonb_build_object(
    'journal', (select count(*) from event_journal where event_id = p_event_id),
    'commands', (select count(*) from event_commands where event_id = p_event_id),
    'projections', (select count(*) from event_projections where event_id = p_event_id),
    'state', (select count(*) from event_states where event_id = p_event_id),
    'printJobs', (select count(*) from print_jobs where event_id = p_event_id),
    'printAttempts', (
      select count(*) from print_attempts attempt
      join print_jobs job on job.job_id = attempt.job_id
      where job.event_id = p_event_id
    ),
    'snapshots', (select count(*) from replica_snapshots where event_id = p_event_id),
    'pendingResets', (
      select count(*) from global_reset_requests where event_id = p_event_id and status = 'pending'
    )
  );
  v_paths := coalesce(
    (select jsonb_agg(storage_path order by storage_path) from replica_snapshots where event_id = p_event_id),
    '[]'::jsonb
  );

  if not p_dry_run then
    -- A pending two-phase request would keep blocking the next one; this wipe supersedes it.
    update global_reset_requests
      set status = 'cancelled', completed_at = p_now
      where event_id = p_event_id and status = 'pending';

    delete from print_attempts
      where job_id in (select job_id from print_jobs where event_id = p_event_id);
    update print_printers set busy_job_id = null, updated_at = p_now
      where event_id = p_event_id and busy_job_id is not null;
    delete from print_jobs where event_id = p_event_id;
    delete from print_counters where event_id = p_event_id;

    delete from event_commands where event_id = p_event_id;
    delete from event_journal where event_id = p_event_id;
    delete from event_projections where event_id = p_event_id;
    delete from replica_snapshots where event_id = p_event_id;

    -- Keep the row (other functions expect it) but empty it; the version only ever moves forward.
    update event_states
      set catalog_payload = jsonb_build_object('products', jsonb_build_array(), 'currentSequence', 0),
          mobile_context = jsonb_build_object(
            'ticketLots', jsonb_build_array(),
            'servicePoints', jsonb_build_array(),
            'voucherCodes', jsonb_build_array(),
            'vouchers', jsonb_build_array(),
            'currentSequence', 0
          ),
          version = version + 1,
          updated_at = p_now
      where event_id = p_event_id;

    -- Desktops apply this command by clearing their own copy, so none of them replays old sales.
    insert into global_commands (command_id, type, event_id, event_name, reason, created_at)
      values ('force-wipe-' || p_wipe_id, 'event.reset', p_event_id, p_event_name, p_reason, p_now)
      on conflict (command_id) do nothing;

    insert into admin_wipe_log (wipe_id, event_id, event_name, reason, actor, counts, created_at)
      values (p_wipe_id, p_event_id, p_event_name, p_reason, p_actor, v_counts, p_now);
  end if;

  return jsonb_build_object(
    'wipeId', p_wipe_id,
    'eventId', p_event_id,
    'dryRun', p_dry_run,
    'counts', v_counts,
    'snapshotPaths', v_paths
  );
end;
$$;

revoke all on function public.gtrz_force_wipe_event(text, text, text, text, text, boolean, bigint)
  from public, anon, authenticated;
grant execute on function public.gtrz_force_wipe_event(text, text, text, text, text, boolean, bigint)
  to service_role;
