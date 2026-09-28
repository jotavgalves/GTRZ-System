-- A valid option can omit a presentation label. Preserve the option's group as
-- the fallback label instead of rejecting an otherwise valid combo selection.
create or replace function public.gtrz_commit_mobile_sale_fast(
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
  v_started_at timestamptz := clock_timestamp();
  v_session record;
  v_state event_states%rowtype;
  v_event_id text;
  v_existing jsonb;
  v_catalog jsonb;
  v_context jsonb;
  v_products jsonb := '[]'::jsonb;
  v_recalculated_products jsonb := '[]'::jsonb;
  v_vouchers jsonb := '[]'::jsonb;
  v_updated_vouchers jsonb := '[]'::jsonb;
  v_consumed jsonb := '{}'::jsonb;
  v_order_items jsonb := '[]'::jsonb;
  v_allocated jsonb;
  v_payload jsonb;
  v_result jsonb;
  v_item jsonb;
  v_product jsonb;
  v_component jsonb;
  v_option jsonb;
  v_selection jsonb;
  v_point jsonb := null;
  v_voucher jsonb;
  v_entry jsonb;
  v_pair record;
  v_product_id text;
  v_item_kind text;
  v_group text;
  v_component_id text;
  v_component_label text;
  v_choice_label text;
  v_operator_name text;
  v_device_id text;
  v_method text;
  v_code text;
  v_quantity bigint;
  v_component_quantity bigint;
  v_selected bigint;
  v_needed bigint;
  v_available bigint;
  v_unit_price bigint;
  v_total bigint := 0;
  v_voucher_amount bigint := 0;
  v_payment bigint;
  v_remaining bigint;
  v_limit bigint;
  v_candidate bigint;
  v_group_available bigint;
  v_result_status text;
begin
  if p_token_hash !~ '^[a-f0-9]{64}$' or p_now < 0 or
     char_length(trim(p_command_id)) = 0 or char_length(p_command_id) > 160 or
     char_length(trim(p_sale_id)) = 0 or char_length(p_sale_id) > 160 or
     char_length(trim(p_service_point_id)) = 0 or char_length(p_service_point_id) > 160 or
     jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'INVALID_MOBILE_SALE';
  end if;

  select
    sessions.session_id,
    sessions.device_id,
    sessions.expires_at,
    sessions.revoked_at,
    sessions.last_seen_at,
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
  if coalesce((v_session.permissions ->> 'sales')::boolean, false) is not true then
    return jsonb_build_object('status', 'forbidden');
  end if;

  select event_id into v_event_id
  from global_commands
  order by sequence desc
  limit 1;
  if v_event_id is null then
    return jsonb_build_object('status', 'no-active-event');
  end if;

  select response_json into v_existing
  from event_commands
  where event_id = v_event_id and command_id = p_command_id;
  if found then
    return jsonb_build_object(
      'status', 'replayed',
      'eventId', v_event_id,
      'response', v_existing,
      'payload', v_existing #> '{event,payload}',
      'serverTiming', jsonb_build_object(
        'commitMs', floor(extract(epoch from clock_timestamp() - v_started_at) * 1000)::integer
      )
    );
  end if;

  insert into event_states (event_id, updated_at)
    values (v_event_id, p_now)
    on conflict (event_id) do nothing;
  select * into v_state from event_states where event_id = v_event_id for update;
  v_catalog := v_state.catalog_payload;
  v_context := v_state.mobile_context;
  v_operator_name := v_session.name;
  v_device_id := left('mobile:' || v_session.operator_id || ':' || v_session.device_id, 80);

  for v_item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) <> 'object' then raise exception 'INVALID_SALE_ITEM'; end if;
    v_product_id := nullif(trim(v_item ->> 'productId'), '');
    if v_product_id is null or char_length(v_product_id) > 160 then raise exception 'INVALID_SALE_ITEM'; end if;
    if jsonb_typeof(v_item -> 'quantity') <> 'number' or (v_item ->> 'quantity') !~ '^[1-9][0-9]*$' then
      raise exception 'INVALID_SALE_ITEM';
    end if;
    v_quantity := (v_item ->> 'quantity')::bigint;
    v_item_kind := case when v_item ->> 'itemKind' = 'combo' then 'combo' else 'product' end;
    v_product := null;
    for v_entry in select value from jsonb_array_elements(coalesce(v_catalog -> 'products', '[]'::jsonb)) loop
      if v_entry ->> 'productId' = v_product_id then
        v_product := v_entry;
        exit;
      end if;
    end loop;
    if v_product is null or v_product ->> 'itemKind' <> v_item_kind or v_product ->> 'active' = 'false' or
       (v_item_kind = 'product' and v_product ->> 'visible' = 'false') then
      raise exception 'ITEM_NOT_AVAILABLE';
    end if;
    if jsonb_typeof(v_product -> 'unitPriceCents') <> 'number' or (v_product ->> 'unitPriceCents') !~ '^[0-9]+$' then
      raise exception 'INVALID_PRODUCT_PRICE';
    end if;
    v_unit_price := (v_product ->> 'unitPriceCents')::bigint;
    v_allocated := '[]'::jsonb;

    if v_item_kind = 'product' then
      v_allocated := v_allocated || jsonb_build_array(jsonb_build_object(
        'productId', v_product_id,
        'quantity', v_quantity,
        'choiceGroup', null,
        'choiceLabel', null,
        'productName', coalesce(v_product ->> 'label', v_product_id)
      ));
    else
      if jsonb_typeof(v_product -> 'components') <> 'array' or jsonb_array_length(v_product -> 'components') = 0 then
        raise exception 'COMBO_WITHOUT_COMPONENTS';
      end if;
      if v_item ? 'componentSelections' and jsonb_typeof(v_item -> 'componentSelections') <> 'array' then
        raise exception 'INVALID_COMBO_SELECTIONS';
      end if;
      for v_component in select value from jsonb_array_elements(v_product -> 'components') loop
        if coalesce(v_component ->> 'choiceGroup', '') <> '' then continue; end if;
        v_component_id := nullif(trim(v_component ->> 'productId'), '');
        if v_component_id is null or jsonb_typeof(v_component -> 'quantity') <> 'number' or
           (v_component ->> 'quantity') !~ '^[1-9][0-9]*$' then raise exception 'INVALID_COMBO_COMPONENT'; end if;
        v_component_quantity := (v_component ->> 'quantity')::bigint * v_quantity;
        v_component_label := v_component_id;
        for v_entry in select value from jsonb_array_elements(v_catalog -> 'products') loop
          if v_entry ->> 'productId' = v_component_id then
            v_component_label := coalesce(v_entry ->> 'label', v_component_id);
            exit;
          end if;
        end loop;
        v_allocated := v_allocated || jsonb_build_array(jsonb_build_object(
          'productId', v_component_id,
          'quantity', v_component_quantity,
          'choiceGroup', null,
          'choiceLabel', null,
          'productName', v_component_label
        ));
      end loop;

      for v_group in
        select distinct value ->> 'choiceGroup'
        from jsonb_array_elements(v_product -> 'components')
        where coalesce(value ->> 'choiceGroup', '') <> ''
      loop
        v_option := null;
        for v_component in select value from jsonb_array_elements(v_product -> 'components') loop
          if v_component ->> 'choiceGroup' = v_group then
            v_option := v_component;
            exit;
          end if;
        end loop;
        if v_option is null or jsonb_typeof(v_option -> 'quantity') <> 'number' or
           (v_option ->> 'quantity') !~ '^[1-9][0-9]*$' then raise exception 'INVALID_COMBO_COMPONENT'; end if;
        v_needed := (v_option ->> 'quantity')::bigint * v_quantity;
        v_selected := 0;
        for v_selection in select value from jsonb_array_elements(coalesce(v_item -> 'componentSelections', '[]'::jsonb)) loop
          if v_selection ->> 'choiceGroup' <> v_group then continue; end if;
          v_component_id := nullif(trim(v_selection ->> 'productId'), '');
          if v_component_id is null or jsonb_typeof(v_selection -> 'quantity') <> 'number' or
             (v_selection ->> 'quantity') !~ '^[1-9][0-9]*$' then raise exception 'INVALID_COMBO_SELECTION'; end if;
          v_component_quantity := (v_selection ->> 'quantity')::bigint;
          v_choice_label := null;
          for v_component in select value from jsonb_array_elements(v_product -> 'components') loop
            if v_component ->> 'choiceGroup' = v_group and v_component ->> 'productId' = v_component_id then
              v_choice_label := coalesce(v_component ->> 'choiceLabel', v_group);
              exit;
            end if;
          end loop;
          if v_choice_label is null then raise exception 'INVALID_COMBO_SELECTION'; end if;
          v_component_label := v_component_id;
          for v_entry in select value from jsonb_array_elements(v_catalog -> 'products') loop
            if v_entry ->> 'productId' = v_component_id then
              v_component_label := coalesce(v_entry ->> 'label', v_component_id);
              exit;
            end if;
          end loop;
          v_selected := v_selected + v_component_quantity;
          v_allocated := v_allocated || jsonb_build_array(jsonb_build_object(
            'productId', v_component_id,
            'quantity', v_component_quantity,
            'choiceGroup', v_group,
            'choiceLabel', v_choice_label,
            'productName', coalesce(v_component_label, v_component_id)
          ));
        end loop;
        if v_selected <> v_needed then raise exception 'COMBO_SELECTION_INCOMPLETE'; end if;
      end loop;
    end if;

    for v_component in select value from jsonb_array_elements(v_allocated) loop
      v_component_id := v_component ->> 'productId';
      v_component_quantity := (v_component ->> 'quantity')::bigint;
      v_consumed := jsonb_set(
        v_consumed,
        array[v_component_id],
        to_jsonb(coalesce((v_consumed ->> v_component_id)::bigint, 0) + v_component_quantity),
        true
      );
    end loop;
    v_order_items := v_order_items || jsonb_build_array(jsonb_build_object(
      'id', p_command_id || ':' || jsonb_array_length(v_order_items),
      'itemKind', v_item_kind,
      'itemId', v_product_id,
      'itemName', coalesce(v_product ->> 'label', v_product_id),
      'quantity', v_quantity,
      'unitPriceCents', v_unit_price,
      'totalCents', v_unit_price * v_quantity,
      'componentAllocations', v_allocated
    ));
    v_total := v_total + (v_unit_price * v_quantity);
  end loop;

  v_point := null;
  for v_entry in select value from jsonb_array_elements(coalesce(v_context -> 'servicePoints', '[]'::jsonb)) loop
    if v_entry ->> 'id' = p_service_point_id and v_entry ->> 'active' = 'true' then
      v_point := v_entry;
      exit;
    end if;
  end loop;
  if v_point is null then raise exception 'SERVICE_POINT_NOT_AVAILABLE'; end if;

  for v_pair in select key, value from jsonb_each(v_consumed) loop
    v_available := null;
    for v_entry in select value from jsonb_array_elements(v_catalog -> 'products') loop
      if v_entry ->> 'productId' = v_pair.key then
        v_available := coalesce((v_entry ->> 'quantity')::bigint, 0);
        exit;
      end if;
    end loop;
    if v_available is null or v_available < (v_pair.value #>> '{}')::bigint then
      raise exception 'INSUFFICIENT_STOCK';
    end if;
  end loop;

  for v_entry in select value from jsonb_array_elements(v_catalog -> 'products') loop
    v_product_id := v_entry ->> 'productId';
    if v_consumed ? v_product_id then
      v_entry := jsonb_set(
        v_entry,
        '{quantity}',
        to_jsonb((v_entry ->> 'quantity')::bigint - (v_consumed ->> v_product_id)::bigint),
        true
      );
    end if;
    v_products := v_products || jsonb_build_array(v_entry);
  end loop;

  -- Recalculate combo availability from the component stock that remains.
  for v_entry in select value from jsonb_array_elements(v_products) loop
    if v_entry ->> 'itemKind' <> 'combo' or v_entry ->> 'active' = 'false' then
      v_recalculated_products := v_recalculated_products || jsonb_build_array(v_entry);
      continue;
    end if;
    v_limit := null;
    for v_component in select value from jsonb_array_elements(coalesce(v_entry -> 'components', '[]'::jsonb)) loop
      if coalesce(v_component ->> 'choiceGroup', '') <> '' then continue; end if;
      v_component_quantity := coalesce((v_component ->> 'quantity')::bigint, 0);
      v_available := 0;
      for v_product in select value from jsonb_array_elements(v_products) loop
        if v_product ->> 'productId' = v_component ->> 'productId' then
          v_available := coalesce((v_product ->> 'quantity')::bigint, 0);
          exit;
        end if;
      end loop;
      v_candidate := case when v_component_quantity > 0 then floor(v_available::numeric / v_component_quantity)::bigint else 0 end;
      v_limit := case when v_limit is null then v_candidate else least(v_limit, v_candidate) end;
    end loop;
    for v_group in
      select distinct value ->> 'choiceGroup'
      from jsonb_array_elements(coalesce(v_entry -> 'components', '[]'::jsonb))
      where coalesce(value ->> 'choiceGroup', '') <> ''
    loop
      v_component_quantity := 0;
      v_group_available := 0;
      for v_component in select value from jsonb_array_elements(v_entry -> 'components') loop
        if v_component ->> 'choiceGroup' <> v_group then continue; end if;
        if v_component_quantity = 0 then v_component_quantity := coalesce((v_component ->> 'quantity')::bigint, 0); end if;
        for v_product in select value from jsonb_array_elements(v_products) loop
          if v_product ->> 'productId' = v_component ->> 'productId' then
            v_group_available := v_group_available + coalesce((v_product ->> 'quantity')::bigint, 0);
            exit;
          end if;
        end loop;
      end loop;
      v_candidate := case when v_component_quantity > 0 then floor(v_group_available::numeric / v_component_quantity)::bigint else 0 end;
      v_limit := case when v_limit is null then v_candidate else least(v_limit, v_candidate) end;
    end loop;
    v_entry := jsonb_set(v_entry, '{quantity}', to_jsonb(greatest(coalesce(v_limit, 0), 0)), true);
    v_recalculated_products := v_recalculated_products || jsonb_build_array(v_entry);
  end loop;
  v_catalog := jsonb_set(v_catalog, '{products}', v_recalculated_products, true);

  if p_voucher_use is not null and p_voucher_use <> 'null'::jsonb then
    if jsonb_typeof(p_voucher_use) <> 'object' or jsonb_typeof(p_voucher_use -> 'amountCents') <> 'number' or
       (p_voucher_use ->> 'amountCents') !~ '^[1-9][0-9]*$' then raise exception 'INVALID_VOUCHER_USE'; end if;
    v_code := upper(nullif(trim(p_voucher_use ->> 'code'), ''));
    if v_code is null or char_length(v_code) > 32 then raise exception 'INVALID_VOUCHER_USE'; end if;
    v_voucher_amount := (p_voucher_use ->> 'amountCents')::bigint;
  end if;
  if v_voucher_amount > v_total then raise exception 'INVALID_VOUCHER_USE'; end if;
  for v_voucher in select value from jsonb_array_elements(coalesce(v_context -> 'vouchers', '[]'::jsonb)) loop
    if v_voucher_amount > 0 and upper(coalesce(v_voucher ->> 'code', '')) = v_code then
      if v_voucher ->> 'status' <> 'active' or v_voucher ->> 'servicePointId' <> p_service_point_id or
         coalesce((v_voucher ->> 'remainingBalanceCents')::bigint, 0) < v_voucher_amount then
        raise exception 'INVALID_VOUCHER_USE';
      end if;
      v_remaining := (v_voucher ->> 'remainingBalanceCents')::bigint - v_voucher_amount;
      v_voucher := jsonb_set(v_voucher, '{remainingBalanceCents}', to_jsonb(v_remaining), true);
      v_voucher := jsonb_set(v_voucher, '{status}', to_jsonb(case when v_remaining = 0 then 'exhausted' else 'active' end), true);
      v_voucher := jsonb_set(v_voucher, '{updatedAt}', to_jsonb(p_now), true);
    end if;
    v_updated_vouchers := v_updated_vouchers || jsonb_build_array(v_voucher);
  end loop;
  if v_voucher_amount > 0 and not exists(
    select 1 from jsonb_array_elements(coalesce(v_context -> 'vouchers', '[]'::jsonb)) as voucher
    where upper(coalesce(voucher.value ->> 'code', '')) = v_code
  ) then raise exception 'INVALID_VOUCHER_USE'; end if;
  v_context := jsonb_set(v_context, '{vouchers}', v_updated_vouchers, true);

  v_payment := v_total - v_voucher_amount;
  v_method := nullif(trim(coalesce(p_payment_method, '')), '');
  if (v_payment = 0 and v_method is not null) or (v_payment > 0 and v_method is null) then
    raise exception 'INVALID_PAYMENT';
  end if;
  if v_method = 'cash' then
    if p_received_cents is null or p_received_cents < v_payment then raise exception 'INVALID_CASH_RECEIVED'; end if;
  else
    p_received_cents := null;
  end if;

  v_payload := jsonb_build_object(
    'commandId', p_command_id,
    'deviceId', v_device_id,
    'auditId', p_now,
    'profile', 'cashier',
    'action', 'operations.order-paid',
    'entityType', 'order',
    'entityId', p_sale_id,
    'createdAt', p_now,
    'details', jsonb_build_object(
      'discountCents', 0,
      'order', jsonb_build_object(
        'id', p_sale_id,
        'openedAt', p_now,
        'servicePointId', p_service_point_id,
        'servicePointLabel', coalesce(v_point ->> 'label', p_service_point_id),
        'servicePointType', case when v_point ->> 'type' = 'table' then 'table' else 'counter' end
      ),
      'items', v_order_items,
      'payments', case when v_method is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object(
        'id', p_command_id || ':payment',
        'method', v_method,
        'amountCents', v_payment,
        'receivedCents', p_received_cents,
        'changeCents', case when p_received_cents is null then 0 else p_received_cents - v_payment end
      )) end,
      'subtotalCents', v_total,
      'totalCents', v_total,
      'totalChangeCents', case when p_received_cents is null then 0 else p_received_cents - v_payment end,
      'stockMovements', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', p_command_id || ':stock:' || key,
          'product_id', key,
          'quantity', (value #>> '{}')::bigint,
          'delta', -((value #>> '{}')::bigint),
          'note', 'Venda no Caixa Mobile ' || v_operator_name,
          'created_at', p_now
        ) order by key), '[]'::jsonb)
        from jsonb_each(v_consumed)
      ),
      'vouchers', case when v_voucher_amount = 0 then '[]'::jsonb else jsonb_build_array(jsonb_build_object(
        'code', v_code,
        'amountCents', v_voucher_amount
      )) end,
      'operatorName', v_operator_name,
      'originLabel', coalesce(v_point ->> 'label', p_service_point_id)
    )
  );

  v_result := public.gtrz_commit_mobile_state(
    v_event_id,
    p_command_id,
    'journal.committed',
    v_payload,
    v_catalog,
    v_context,
    v_state.version,
    p_now
  );
  v_result_status := v_result ->> 'status';
  if v_result_status not in ('accepted', 'replayed') then raise exception 'MOBILE_SALE_CONFLICT'; end if;

  update mobile_sessions
  set last_seen_at = greatest(last_seen_at, p_now)
  where session_id = v_session.session_id
    and last_seen_at < p_now - 30000;

  return v_result || jsonb_build_object(
    'eventId', v_event_id,
    'payload', v_payload,
    'serverTiming', jsonb_build_object(
      'commitMs', floor(extract(epoch from clock_timestamp() - v_started_at) * 1000)::integer
    )
  );
end;
$$;

revoke all on function public.gtrz_commit_mobile_sale_fast(text, text, text, text, jsonb, text, bigint, jsonb, bigint)
  from public, anon, authenticated;
grant execute on function public.gtrz_commit_mobile_sale_fast(text, text, text, text, jsonb, text, bigint, jsonb, bigint)
  to service_role;
