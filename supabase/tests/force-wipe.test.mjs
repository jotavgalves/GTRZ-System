// Testa a funcao gtrz_force_wipe_event contra um Postgres real em memoria (PGlite): aplica TODAS as
// migracoes em ordem, semeia dois eventos e confere simulacao, apagamento, protecoes e permissoes.
//
// Rodar (nao e dependencia do projeto; instale so para este teste):
//   npm install --no-save @electric-sql/pglite
//   node supabase/tests/force-wipe.test.mjs

import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = process.argv[2] ?? fileURLToPath(new URL('../migrations/', import.meta.url));
const db = new PGlite();
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failures += 1;
};

// Minimal stand-ins for what Supabase provides outside this repository.
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint);
`);

const files = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort();
for (const file of files) {
  try {
    await db.exec(readFileSync(path.join(dir, file), 'utf8'));
    console.log(`ok migration ${file}`);
  } catch (error) {
    console.log(`ERRO em ${file}: ${error.message}`);
    process.exit(2);
  }
}

const rpc = async (dry, eventId = 'ev1', wipeId = 'w' + Math.random().toString(36).slice(2, 8)) =>
  (
    await db.query(`select public.gtrz_force_wipe_event($1,$2,$3,$4,$5,$6,$7) as r`, [
      wipeId,
      eventId,
      'MACABRA',
      'limpeza de teste',
      'owner@example.com',
      dry,
      1000,
    ])
  ).rows[0].r;
const count = async (sql, ...p) => Number((await db.query(sql, p)).rows[0].n);

// ---- seed two events: ev1 (to wipe) and ev2 (must survive) plus the shared catalogue.
await db.exec(`
  insert into gtrz.desktop_devices (device_id,label,last_seen_at,created_at) values ('pc1','PC 1',1,1),('stale','PC antigo',1,1);
  insert into gtrz.event_journal (event_id,command_id,type,payload,created_at) values
    ('ev1','a','journal.committed','{}',1),('ev1','b','journal.committed','{}',1),
    ('ev2','c','journal.committed','{}',1),('_catalog','p','journal.committed','{}',1);
  insert into gtrz.event_commands (event_id,command_id,response_json,created_at) values
    ('ev1','a','{}',1),('ev2','c','{}',1);
  insert into gtrz.event_projections (event_id,projection,payload,updated_at) values
    ('ev1','cashier-catalog','{}',1),('ev1','mobile-context','{}',1),('ev2','cashier-catalog','{}',1);
  insert into gtrz.event_states (event_id,version,updated_at) values ('ev1',5,1),('ev2',7,1);
  update gtrz.event_states set catalog_payload='{"products":[{"x":1}],"currentSequence":9}' where event_id='ev1';
  insert into gtrz.print_printers (printer_id,event_id,device_id,device_label,printer_name,paper_width_mm,enabled,busy_job_id,last_seen_at,updated_at)
    values ('pr1','ev1','pc1','PC 1','POS-80',80,true,'j1',1,1);
  insert into gtrz.print_jobs (job_id,event_id,idempotency_key,command_id,order_id,document_json,status,assigned_printer_id,created_at,updated_at)
    values ('j1','ev1','k1','a','o1','{}','claimed','pr1',1,1),('j2','ev1','k2','b','o2','{}','queued',null,1,1),('j3','ev2','k3','c','o3','{}','queued',null,1,1);
  insert into gtrz.print_attempts (attempt_id,job_id,printer_id,device_id,result,created_at) values ('at1','j1','pr1','pc1','claimed',1);
  insert into gtrz.print_counters (event_id,next_number) values ('ev1',9),('ev2',3);
  insert into gtrz.replica_snapshots (snapshot_id,event_id,source_device_id,storage_path,sha256,size_bytes,created_at)
    values ('s1','ev1','pc1','ev1/s1.sqlite','${'a'.repeat(64)}',10,1),('s2','ev2','pc1','ev2/s2.sqlite','${'b'.repeat(64)}',10,1);
  insert into gtrz.global_reset_requests (request_id,event_id,event_name,reason,requested_by_device_id,target_device_ids,status,created_at)
    values ('rq1','ev1','MACABRA','teste','pc1','["pc1","stale"]','pending',1);
`);

// 1) dry run: reports counts, deletes nothing, writes nothing.
const dry = await rpc(true);
check(
  'simulacao conta o diario',
  dry.counts.journal === 2 && dry.counts.commands === 1,
  JSON.stringify(dry.counts),
);
check(
  'simulacao conta impressao, snapshots e pedido pendente',
  dry.counts.printJobs === 2 &&
    dry.counts.printAttempts === 1 &&
    dry.counts.snapshots === 1 &&
    dry.counts.pendingResets === 1,
);
check(
  'simulacao devolve o caminho do snapshot',
  JSON.stringify(dry.snapshotPaths) === '["ev1/s1.sqlite"]',
);
check(
  'simulacao nao apaga nada',
  (await count(`select count(*) n from gtrz.event_journal where event_id='ev1'`)) === 2,
);
check(
  'simulacao nao grava auditoria nem comando',
  (await count(`select count(*) n from gtrz.admin_wipe_log`)) === 0 &&
    (await count(`select count(*) n from gtrz.global_commands`)) === 0,
);

// 2) protections.
let protectedMessage = '';
try {
  await rpc(false, '_catalog');
} catch (e) {
  protectedMessage = e.message;
}
check(
  'recusa o catalogo compartilhado',
  protectedMessage.includes('PROTECTED_EVENT'),
  protectedMessage,
);
let invalid = '';
try {
  await db.query(`select public.gtrz_force_wipe_event('w','ev1','MACABRA','ab','owner',false,1)`);
} catch (e) {
  invalid = e.message;
}
check('recusa motivo curto', invalid.includes('INVALID_FORCE_WIPE'), invalid);
check(
  'recusas nao apagaram nada',
  (await count(`select count(*) n from gtrz.event_journal`)) === 4,
);

// 3) the real wipe.
const real = await rpc(false);
check(
  'apagamento devolve as mesmas contagens da simulacao',
  JSON.stringify(real.counts) === JSON.stringify(dry.counts),
);
check(
  'diario do evento apagado',
  (await count(`select count(*) n from gtrz.event_journal where event_id='ev1'`)) === 0,
);
check(
  'comandos, projecoes e snapshots do evento apagados',
  (await count(
    `select (select count(*) from gtrz.event_commands where event_id='ev1') + (select count(*) from gtrz.event_projections where event_id='ev1') + (select count(*) from gtrz.replica_snapshots where event_id='ev1') n`,
  )) === 0,
);
check(
  'fila de impressao do evento apagada',
  (await count(
    `select (select count(*) from gtrz.print_jobs where event_id='ev1') + (select count(*) from gtrz.print_attempts) + (select count(*) from gtrz.print_counters where event_id='ev1') n`,
  )) === 0,
);
check(
  'impressora liberada, nao apagada',
  (await count(
    `select count(*) n from gtrz.print_printers where event_id='ev1' and busy_job_id is null`,
  )) === 1,
);
const st = (
  await db.query(`select version, catalog_payload from gtrz.event_states where event_id='ev1'`)
).rows[0];
check(
  'estado esvaziado e versao so avanca',
  Number(st.version) === 6 && st.catalog_payload.products.length === 0,
  JSON.stringify(st),
);
check(
  'pedido de reset pendente cancelado',
  (await count(
    `select count(*) n from gtrz.global_reset_requests where request_id='rq1' and status='cancelled'`,
  )) === 1,
);
const cmd = (await db.query(`select type,event_id,event_name from gtrz.global_commands`)).rows;
check(
  'emitiu o comando event.reset para os PCs',
  cmd.length === 1 && cmd[0].type === 'event.reset' && cmd[0].event_id === 'ev1',
  JSON.stringify(cmd),
);
check(
  'gravou auditoria com quem pediu',
  (await count(
    `select count(*) n from gtrz.admin_wipe_log where actor='owner@example.com' and event_id='ev1'`,
  )) === 1,
);

// 4) other data untouched.
check(
  'outro evento intacto',
  (await count(
    `select (select count(*) from gtrz.event_journal where event_id='ev2') + (select count(*) from gtrz.event_commands where event_id='ev2') + (select count(*) from gtrz.event_projections where event_id='ev2') + (select count(*) from gtrz.print_jobs where event_id='ev2') + (select count(*) from gtrz.replica_snapshots where event_id='ev2') n`,
  )) === 5,
);
check(
  'estado do outro evento intacto',
  Number(
    (await db.query(`select version from gtrz.event_states where event_id='ev2'`)).rows[0].version,
  ) === 7,
);
check(
  'catalogo compartilhado intacto',
  (await count(`select count(*) n from gtrz.event_journal where event_id='_catalog'`)) === 1,
);
check(
  'dispositivos e operadores nao foram tocados',
  (await count(`select count(*) n from gtrz.desktop_devices`)) === 2,
);

// 5) running it again is safe (nothing left, still logs, one command per wipe id).
const again = await rpc(false);
check(
  'repetir e seguro e conta zero',
  again.counts.journal === 0 && again.counts.printJobs === 0 && again.counts.snapshots === 0,
);
// 6) the same wipe id twice cannot duplicate the audit row.
let dup = '';
try {
  await rpc(false, 'ev1', 'fixed');
  await rpc(false, 'ev1', 'fixed');
} catch (e) {
  dup = e.message;
}
check('mesmo wipe_id nao duplica a auditoria', dup.length > 0, dup.slice(0, 60));

// 7) privileges: only service_role may execute it.
const grants = (
  await db.query(
    `select grantee from information_schema.routine_privileges where routine_name='gtrz_force_wipe_event' order by grantee`,
  )
).rows.map((r) => r.grantee);
check(
  'somente service_role executa a funcao',
  grants.includes('service_role') &&
    !grants.includes('anon') &&
    !grants.includes('authenticated') &&
    !grants.includes('PUBLIC'),
  JSON.stringify(grants),
);

console.log(failures === 0 ? '\nTODOS OS TESTES DE SQL PASSARAM' : `\n${failures} FALHA(S)`);
process.exit(failures === 0 ? 0 : 1);
