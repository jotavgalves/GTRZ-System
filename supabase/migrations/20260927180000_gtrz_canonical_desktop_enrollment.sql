-- Desktop credentials are issued through a short-lived, single-use enrollment
-- code. The central retains only SHA-256 hashes; device secrets are never stored.
alter table gtrz.desktop_devices
  add column if not exists credential_hash text;

create table if not exists gtrz.desktop_enrollment_codes (
  code_hash text primary key check (code_hash ~ '^[a-f0-9]{64}$'),
  created_by_device_id text not null references gtrz.desktop_devices(device_id),
  expires_at bigint not null check (expires_at >= 0),
  created_at bigint not null check (created_at >= 0),
  consumed_at bigint,
  consumed_by_device_id text
);

create index if not exists desktop_enrollment_codes_expiry_idx
  on gtrz.desktop_enrollment_codes (expires_at);

alter table gtrz.desktop_enrollment_codes enable row level security;
revoke all on gtrz.desktop_enrollment_codes from public, anon, authenticated;
grant select, insert, update, delete on gtrz.desktop_enrollment_codes to service_role;

create or replace function public.gtrz_create_desktop_enrollment(
  p_code_hash text,
  p_created_by_device_id text,
  p_now bigint
) returns jsonb
language plpgsql
security definer
set search_path = gtrz, public, pg_temp
as $$
declare
  v_expires_at bigint := p_now + 900000;
begin
  if p_code_hash !~ '^[a-f0-9]{64}$' or char_length(trim(p_created_by_device_id)) = 0 or p_now < 0 then
    raise exception 'INVALID_ENROLLMENT';
  end if;
  if not exists (
    select 1 from desktop_devices
    where device_id = p_created_by_device_id and revoked_at is null
  ) then
    raise exception 'DEVICE_NOT_REGISTERED';
  end if;

  delete from desktop_enrollment_codes
    where expires_at <= p_now or consumed_at is not null;
  insert into desktop_enrollment_codes (code_hash, created_by_device_id, expires_at, created_at)
    values (p_code_hash, p_created_by_device_id, v_expires_at, p_now);
  return jsonb_build_object('expiresAt', v_expires_at);
end;
$$;

create or replace function public.gtrz_exchange_desktop_enrollment(
  p_code_hash text,
  p_device_id text,
  p_label text,
  p_credential_hash text,
  p_now bigint
) returns jsonb
language plpgsql
security definer
set search_path = gtrz, public, pg_temp
as $$
declare
  v_code desktop_enrollment_codes%rowtype;
begin
  if p_code_hash !~ '^[a-f0-9]{64}$' or p_credential_hash !~ '^[a-f0-9]{64}$' or
     char_length(trim(p_device_id)) = 0 or char_length(p_device_id) > 160 or
     char_length(trim(p_label)) = 0 or char_length(p_label) > 120 or p_now < 0 then
    raise exception 'INVALID_ENROLLMENT';
  end if;

  select * into v_code from desktop_enrollment_codes
    where code_hash = p_code_hash for update;
  if not found or v_code.consumed_at is not null or v_code.expires_at <= p_now then
    raise exception 'ENROLLMENT_CODE_INVALID';
  end if;

  insert into desktop_devices
    (device_id, label, active_event_id, last_seen_at, created_at, revoked_at, credential_hash)
    values (p_device_id, trim(p_label), null, p_now, p_now, null, p_credential_hash)
    on conflict (device_id) do update
      set label = excluded.label,
          last_seen_at = excluded.last_seen_at,
          revoked_at = null,
          credential_hash = excluded.credential_hash;

  update desktop_enrollment_codes
    set consumed_at = p_now, consumed_by_device_id = p_device_id
    where code_hash = p_code_hash;
  return jsonb_build_object('deviceId', p_device_id, 'accepted', true);
end;
$$;

create or replace function public.gtrz_authorize_desktop_device(
  p_device_id text,
  p_credential_hash text,
  p_seen_at bigint
) returns jsonb
language plpgsql
security definer
set search_path = gtrz, public, pg_temp
as $$
begin
  if p_credential_hash !~ '^[a-f0-9]{64}$' or char_length(trim(p_device_id)) = 0 or p_seen_at < 0 then
    return jsonb_build_object('authorized', false);
  end if;
  update desktop_devices
    set last_seen_at = greatest(last_seen_at, p_seen_at)
    where device_id = p_device_id
      and credential_hash = p_credential_hash
      and revoked_at is null;
  return jsonb_build_object('authorized', found);
end;
$$;

revoke all on function public.gtrz_create_desktop_enrollment(text, text, bigint) from public, anon, authenticated;
revoke all on function public.gtrz_exchange_desktop_enrollment(text, text, text, text, bigint) from public, anon, authenticated;
revoke all on function public.gtrz_authorize_desktop_device(text, text, bigint) from public, anon, authenticated;
grant execute on function public.gtrz_create_desktop_enrollment(text, text, bigint) to service_role;
grant execute on function public.gtrz_exchange_desktop_enrollment(text, text, text, text, bigint) to service_role;
grant execute on function public.gtrz_authorize_desktop_device(text, text, bigint) to service_role;
