-- The mobile journal stores itemName/componentAllocations; thermal receipts
-- consume name/preparation. Build the document in the printer contract inside
-- the same transaction as the paid sale and its idempotent print job.
create or replace function public.gtrz_commit_mobile_sale_with_receipt(
  p_token_hash text,
  p_command_id text,
  p_sale_id text,
  p_service_point_id text,
  p_items jsonb,
  p_payment_method text,
  p_received_cents bigint,
  p_voucher_use jsonb,
  p_now bigint
) returns jsonb
language plpgsql
security definer
set search_path = gtrz, public, pg_temp
as $$
declare
  v_result jsonb;
  v_event_id text;
  v_event_name text;
  v_payload jsonb;
  v_details jsonb;
  v_receipt_items jsonb;
  v_document jsonb;
begin
  v_result := public.gtrz_commit_mobile_sale_fast(
    p_token_hash, p_command_id, p_sale_id, p_service_point_id, p_items,
    p_payment_method, p_received_cents, p_voucher_use, p_now
  );

  if v_result ->> 'status' not in ('accepted', 'replayed') then
    return v_result;
  end if;

  v_event_id := nullif(v_result ->> 'eventId', '');
  v_payload := v_result -> 'payload';
  v_details := v_payload -> 'details';
  if v_event_id is null or v_payload is null or v_details is null then
    raise exception 'MOBILE_SALE_RECEIPT_PAYLOAD_INVALID';
  end if;

  select event_name into v_event_name
  from global_commands
  where event_id = v_event_id
  order by sequence desc
  limit 1;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'name', coalesce(nullif(item ->> 'itemName', ''), nullif(item ->> 'name', ''), 'Item sem nome'),
      'quantity', coalesce(item -> 'quantity', '0'::jsonb),
      'unitPriceCents', coalesce(item -> 'unitPriceCents', '0'::jsonb),
      'totalCents', coalesce(item -> 'totalCents', '0'::jsonb),
      'preparation', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'label', coalesce(nullif(choice ->> 'choiceLabel', ''), choice ->> 'choiceGroup'),
          'productName', choice ->> 'productName',
          'quantity', coalesce(choice -> 'quantity', '1'::jsonb)
        ) order by choice_index), '[]'::jsonb)
        from jsonb_array_elements(coalesce(item -> 'componentAllocations', '[]'::jsonb))
          with ordinality as choices(choice, choice_index)
        where nullif(choice ->> 'choiceGroup', '') is not null
          and nullif(choice ->> 'productName', '') is not null
      )
    ) order by item_index), '[]'::jsonb)
  into v_receipt_items
  from jsonb_array_elements(coalesce(v_details -> 'items', '[]'::jsonb))
    with ordinality as items(item, item_index);

  v_document := jsonb_build_object(
    'orderId', p_sale_id,
    'eventName', coalesce(v_event_name, 'Evento ' || upper(left(v_event_id, 8))),
    'servicePointLabel', coalesce(v_details #>> '{order,servicePointLabel}', 'Caixa GTRZ'),
    'servicePointType', case when v_details #>> '{order,servicePointType}' = 'table' then 'table' else 'counter' end,
    'subtotalCents', coalesce(v_details -> 'subtotalCents', '0'::jsonb),
    'discountCents', coalesce(v_details -> 'discountCents', '0'::jsonb),
    'totalCents', coalesce(v_details -> 'totalCents', '0'::jsonb),
    'closedAt', coalesce(v_payload -> 'createdAt', to_jsonb(p_now)),
    'operatorName', coalesce(v_details -> 'operatorName', to_jsonb('Operador GTRZ'::text)),
    'originLabel', coalesce(v_details -> 'originLabel', v_details #> '{order,servicePointLabel}', to_jsonb('GTRZ System'::text)),
    'items', v_receipt_items,
    'payments', coalesce(v_details -> 'payments', '[]'::jsonb),
    'vouchers', coalesce(v_details -> 'vouchers', '[]'::jsonb),
    'documentType', 'sale-batch'
  );

  perform public.gtrz_enqueue_print_job(
    v_event_id, p_command_id, 'receipt:' || p_sale_id,
    p_sale_id, v_document, p_now
  );

  return v_result || jsonb_build_object('receiptQueued', true);
end;
$$;

revoke all on function public.gtrz_commit_mobile_sale_with_receipt(text, text, text, text, jsonb, text, bigint, jsonb, bigint)
  from public, anon, authenticated;
grant execute on function public.gtrz_commit_mobile_sale_with_receipt(text, text, text, text, jsonb, text, bigint, jsonb, bigint)
  to service_role;
