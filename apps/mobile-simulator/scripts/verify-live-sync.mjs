import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright';
import { createClient, REALTIME_SUBSCRIBE_STATES } from '@supabase/supabase-js';

const edgeUrl =
  process.env.GTRZ_EDGE_URL ??
  'https://muhzjnveqrahccoisddo.supabase.co/functions/v1/gtrz-sync-fallback';
const projectUrl = 'https://muhzjnveqrahccoisddo.supabase.co';
const publishableKey = 'sb_publishable_ikPSVbY1junIsMbz5SrFrg_wkobALXv';
const debugPort = Number(process.env.GTRZ_MOBILE_CDP_PORT ?? '9224');
const pairingPath =
  process.env.GTRZ_PAIRING_KEY_PATH ??
  path.join(os.homedir(), 'Documents', 'GTRZ System', 'Nuvem GTRZ - chave de pareamento.txt');

function pairingKey() {
  if (!fs.existsSync(pairingPath)) {
    throw new Error(`Chave de pareamento não encontrada em ${pairingPath}.`);
  }
  const value = fs
    .readFileSync(pairingPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!value) throw new Error('Chave de pareamento vazia.');
  return value;
}

async function edgeRequest(relativePath, options = {}) {
  const response = await fetch(`${edgeUrl}${relativePath}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-GTRZ-Key': pairingKey(),
      ...options.headers,
    },
  });
  if (!response.ok) throw new Error(`Central recusou ${relativePath}: HTTP ${response.status}.`);
  return response.json();
}

async function activeEventId() {
  if (process.env.GTRZ_EVENT_ID) return process.env.GTRZ_EVENT_ID;
  const control = await edgeRequest('/v1/monitor/global-control');
  const command = Array.isArray(control.commands) ? control.commands.at(-1) : null;
  if (!command || typeof command.eventId !== 'string') {
    throw new Error('Nenhum evento global ativo para validar a sincronização.');
  }
  return command.eventId;
}

async function main() {
  const eventId = await activeEventId();
  const topicReply = await edgeRequest(`/v1/events/${eventId}/realtime-topic`);
  if (typeof topicReply.topic !== 'string' || topicReply.topic.length === 0) {
    throw new Error('A central não forneceu o tópico em tempo real.');
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().endsWith('/cashier'));
  if (!page) throw new Error('O GTRZ System Mobile instalado não está aberto na porta de teste.');

  const protocol = await page.context().newCDPSession(page);
  await protocol.send('Network.enable');
  const milestones = [];
  const startedAt = Date.now();
  protocol.on('Network.webSocketFrameReceived', ({ response }) => {
    if (response.payloadData.includes('state-changed')) {
      milestones.push({ step: 'sinal-websocket', elapsedMs: Date.now() - startedAt });
    }
  });
  protocol.on('Network.requestWillBeSent', ({ request }) => {
    const match = request.url.match(/\/v1\/mobile\/(session|catalog|context)/);
    if (match) milestones.push({ step: match[1], elapsedMs: Date.now() - startedAt });
  });

  const desktopReplica = createClient(projectUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let resolveBroadcast;
  const broadcastReceived = new Promise((resolve) => {
    resolveBroadcast = resolve;
  });
  const channel = desktopReplica
    .channel(topicReply.topic)
    .on('broadcast', { event: 'state-changed' }, ({ payload }) => {
      if (payload?.eventId === eventId) resolveBroadcast();
    });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Assinante equivalente ao desktop não conectou em 10 segundos.')),
      10_000,
    );
    channel.subscribe((status) => {
      if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) {
        clearTimeout(timeout);
        resolve();
      } else if (
        status === REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR ||
        status === REALTIME_SUBSCRIBE_STATES.TIMED_OUT
      ) {
        clearTimeout(timeout);
        reject(new Error(`Assinante equivalente ao desktop: ${status}.`));
      }
    });
  });

  await edgeRequest('/v1/monitor/realtime-ping', {
    method: 'POST',
    body: JSON.stringify({ eventId }),
  });
  await Promise.race([
    broadcastReceived,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('O broadcast não chegou ao assinante do desktop.')), 10_000),
    ),
  ]);

  const requiredSteps = ['sinal-websocket', 'session', 'catalog', 'context'];
  const deadline = Date.now() + 10_000;
  while (
    Date.now() < deadline &&
    !requiredSteps.every((step) => milestones.some((milestone) => milestone.step === step))
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  await desktopReplica.removeChannel(channel);
  await protocol.detach();
  const missingSteps = requiredSteps.filter(
    (step) => !milestones.some((milestone) => milestone.step === step),
  );
  console.log(
    JSON.stringify({
      simulator: 'installed',
      eventId,
      desktopReplicaReceived: true,
      milestones,
      passed: missingSteps.length === 0,
      missingSteps,
    }),
  );
  process.exit(missingSteps.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
