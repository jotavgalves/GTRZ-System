import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, type DatabaseContext } from '@gtrz/database';
import { reconcileOperationIds } from '../../apps/desktop/src/main/operation-reconciliation';
const files: string[] = [];
const databases: DatabaseContext[] = [];
function database() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gtrz-durable-'));
  files.push(dir);
  const db = openDatabase(path.join(dir, 'test.sqlite'));
  databases.push(db);
  db.sqlite.exec(
    "INSERT INTO events(id,name,status,starts_at,ends_at,created_at,updated_at) VALUES('event','Test','open',1,NULL,1,1)",
  );
  return db;
}
function audit(db: DatabaseContext, details = {}) {
  return db.sqlite
    .prepare(
      "INSERT INTO audit_log(event_id,profile,action,entity_type,entity_id,details_json,created_at) VALUES('event','production','cash.opened','cash','cash',?,?)",
    )
    .run(JSON.stringify(details), Date.now()).lastInsertRowid;
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const file of files.splice(0)) rmSync(file, { recursive: true, force: true });
});
describe('durable operation reconciliation', () => {
  it('commits an operation and its outgoing ID together and rolls both back on failure', () => {
    const db = database();
    expect(() =>
      db.sqlite.transaction(() => {
        audit(db);
        throw new Error('power cut before commit');
      })(),
    ).toThrow();
    expect(db.sqlite.prepare('select count(*) n from sync_outbox').get()).toEqual({ n: 0 });
    const id = audit(db);
    const row = db.sqlite
      .prepare('select operation_id,status from sync_outbox where audit_id=?')
      .get(id) as { operation_id: string; status: string };
    expect(row.operation_id).toMatch(/^[a-f0-9]{32}$/);
    expect(row.status).toBe('pending');
    expect(
      db.sqlite.prepare('select operation_id from local_operation_ids where audit_id=?').get(id),
    ).toEqual({ operation_id: row.operation_id });
  });
  it('keeps committed IDs across restart and does not echo replicated cloud audits', () => {
    const db = database();
    audit(db);
    const before = db.sqlite.prepare('select operation_id from sync_outbox').get();
    audit(db, { _cloudReplicated: true });
    expect(db.sqlite.prepare('select count(*) n from sync_outbox').get()).toEqual({ n: 1 });
    const reopened = openDatabase(db.filePath);
    expect(reopened.sqlite.prepare('select operation_id from sync_outbox').get()).toEqual(before);
    reopened.close();
  });
  it('requeues an accepted operation missing from the cloud with its original ID', async () => {
    const db = database();
    audit(db);
    const row = db.sqlite.prepare('select operation_id from sync_outbox').get() as {
      operation_id: string;
    };
    db.sqlite.exec("update sync_outbox set status='accepted',accepted_at=1");
    const result = await reconcileOperationIds(
      db,
      'event',
      () => Promise.resolve({ events: [] }),
      () => undefined,
    );
    expect(result.resent).toBe(1);
    expect(db.sqlite.prepare('select operation_id,status from sync_outbox').get()).toEqual({
      ...row,
      status: 'pending',
    });
  });
  it('does not requeue anything when the inventory request is interrupted', async () => {
    const db = database();
    audit(db);
    db.sqlite.exec("update sync_outbox set status='accepted',accepted_at=1");
    await expect(
      reconcileOperationIds(
        db,
        'event',
        () => Promise.reject(new Error('offline')),
        () => undefined,
      ),
    ).rejects.toThrow('offline');
    expect(db.sqlite.prepare('select status from sync_outbox').get()).toEqual({
      status: 'accepted',
    });
  });
  it('uses IDs rather than an equal cursor and records an identity collision as unresolved', async () => {
    const db = database();
    db.sqlite.prepare("insert into sync_inbox values('event',5,'old-id','{}',1,1)").run();
    db.sqlite.prepare("insert into sync_state values('inbox.sequence:event','5',1)").run();
    let call = 0;
    const result = await reconcileOperationIds(
      db,
      'event',
      () =>
        Promise.resolve({
          events:
            call++ === 0
              ? [
                  {
                    sequence: 5,
                    commandId: 'real-cloud-id',
                    type: 'journal.committed',
                    payload: {},
                  },
                ]
              : [],
        }),
      () => {
        throw new Error('must not silently replay conflicting history');
      },
    );
    expect(result.historicalGaps).toBe(1);
    expect(db.sqlite.prepare('select command_id,resolved_at from sync_conflicts').get()).toEqual({
      command_id: 'real-cloud-id',
      resolved_at: null,
    });
  });
  it('keeps an intentionally retired ID excluded instead of receiving it or flagging a gap', async () => {
    const db = database();
    db.sqlite.prepare("insert into sync_state values('inbox.sequence:event','10',1)").run();
    const cloudEvent = (sequence: number, commandId: string) => ({
      sequence,
      commandId,
      type: 'journal.committed',
      payload: { action: 'order.paid', entityId: 'order-' + commandId },
    });
    const scan = async () => {
      let call = 0;
      const received: string[] = [];
      const result = await reconcileOperationIds(
        db,
        'event',
        () =>
          Promise.resolve({
            events:
              call++ === 0 ? [cloudEvent(3, 'retired-sale'), cloudEvent(4, 'other-sale')] : [],
          }),
        (events) => received.push(...events.map((e) => e.commandId)),
      );
      return { result, received };
    };
    db.sqlite
      .prepare(
        "insert into sync_operation_tombstones(event_id,command_id,entity_id,reason,confirmed_at) values('event','retired-sale','order-retired-sale','exclusão intencional',1)",
      )
      .run();
    const { result, received } = await scan();
    expect(received).toEqual([]);
    expect(result.historicalGaps).toBe(1);
    expect(db.sqlite.prepare('select command_id from sync_conflicts').all()).toEqual([
      { command_id: 'other-sale' },
    ]);
    expect(
      db.sqlite
        .prepare("select count(*) n from sync_id_inventory where command_id='retired-sale'")
        .get(),
    ).toEqual({ n: 1 });
  });
  it('receives remote IDs that are missing locally and leaves acknowledged IDs unchanged', async () => {
    const db = database();
    audit(db);
    const id = (
      db.sqlite.prepare('select operation_id from sync_outbox').get() as { operation_id: string }
    ).operation_id;
    db.sqlite.exec("update sync_outbox set status='accepted',accepted_at=1");
    let call = 0;
    const received: string[] = [];
    await reconcileOperationIds(
      db,
      'event',
      () =>
        Promise.resolve({
          events:
            call++ === 0
              ? [{ sequence: 1, commandId: id, type: 'journal.committed', payload: {} }]
              : [],
        }),
      (events) => received.push(...events.map((e) => e.commandId)),
    );
    expect(received).toEqual([id]);
    expect(db.sqlite.prepare('select status from sync_outbox').get()).toEqual({
      status: 'accepted',
    });
  });
});
