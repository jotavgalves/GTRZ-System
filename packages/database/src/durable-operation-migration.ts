export const durableOperationMigration = {
  version: 30,
  name: 'durable-operation-identities-and-atomic-outbox',
  sql: `
    CREATE TABLE sync_operation_tombstones(event_id TEXT NOT NULL,command_id TEXT NOT NULL,entity_id TEXT,reason TEXT NOT NULL,confirmed_at INTEGER NOT NULL,PRIMARY KEY(event_id,command_id));
    CREATE TABLE lan_sessions(token_hash TEXT PRIMARY KEY,event_id TEXT NOT NULL,operator_json TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE lan_commands(command_id TEXT PRIMARY KEY,event_id TEXT NOT NULL,operator_id TEXT NOT NULL,sale_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,response_json TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE local_operation_ids (
      audit_id INTEGER PRIMARY KEY REFERENCES audit_log(id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL UNIQUE
    );
    CREATE TABLE sync_id_inventory (
      event_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      scan_id TEXT NOT NULL,
      PRIMARY KEY (event_id, command_id)
    );
    CREATE TRIGGER audit_durable_operation AFTER INSERT ON audit_log
    WHEN COALESCE(json_extract(NEW.details_json, '$._cloudReplicated'), 0) != 1
    BEGIN
      INSERT INTO local_operation_ids(audit_id, operation_id)
        VALUES (NEW.id, lower(hex(randomblob(16))));
      INSERT INTO sync_outbox
        (audit_id, operation_id, event_id, payload_json, status, attempts, created_at, updated_at)
      SELECT NEW.id, ids.operation_id,
        CASE WHEN NEW.action IN ('event.created', 'event.renamed', 'event.open', 'event.closed', 'event.archived', 'event.deleted-permanently', 'inventory.category-created', 'inventory.category-updated', 'inventory.category-deleted', 'inventory.product-created', 'inventory.product-updated', 'inventory.product-deleted', 'combo.created', 'combo.updated', 'combo.deleted') THEN '_catalog'
             ELSE COALESCE(NEW.event_id, '_catalog') END,
        json_object('commandId', ids.operation_id, 'deviceId', 'unassigned',
          'auditId', NEW.id, 'profile', NEW.profile, 'action', NEW.action,
          'entityType', NEW.entity_type, 'entityId', NEW.entity_id,
          'details', json(NEW.details_json), 'createdAt', NEW.created_at),
        'pending', 0, NEW.created_at, NEW.created_at
      FROM local_operation_ids ids
      WHERE ids.audit_id = NEW.id AND NEW.action IN ('sync.operations-retired', 'event.created', 'event.renamed', 'event.open', 'event.closed', 'event.archived', 'event.deleted-permanently', 'inventory.category-created', 'inventory.category-updated', 'inventory.category-deleted', 'inventory.product-created', 'inventory.product-updated', 'inventory.product-deleted', 'combo.created', 'combo.updated', 'combo.deleted', 'inventory.stock-moved', 'inventory.purchase-lot-corrected', 'inventory.purchase-lot-voided', 'food.configured', 'food.supplier-created', 'food.supplier-updated', 'food.supplier-archived', 'food.supplier-deleted', 'food.external-item-created', 'operations.service-point-created', 'operations.service-point-renamed', 'operations.service-point-pinned', 'operations.service-point-deleted', 'operations.order-paid', 'operations.order-cancelled', 'expense.created', 'expense.updated', 'expense.payment-status-changed', 'expense.payment-recorded', 'expense.cancelled', 'expense.deleted', 'capital.contribution-created', 'capital.contribution-updated', 'capital.reimbursed', 'cash.opened', 'cash.supply', 'cash.withdrawal', 'cash.closed', 'voucher.created', 'voucher.service-point-bound', 'voucher.updated', 'voucher.balance-added', 'voucher.value-updated', 'voucher.cancelled', 'voucher.active', 'voucher.deleted', 'voucher.deleted-with-reversal', 'ticket.lot-created', 'ticket.lot-updated', 'ticket.sale-created', 'ticket.courtesy-created', 'ticket.sale-cancelled', 'ticket.lot-deleted', 'ticket.sale-deleted');
    END;
  `,
} as const;
