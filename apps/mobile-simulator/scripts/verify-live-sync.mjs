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

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  const eventId = await activeEventId();
  const topicReply = await edgeRequest(`/v1/events/${eventId}/realtime-topic`);
  if (typeof topicReply.topic !== 'string' || topicReply.topic.length === 0) {
    throw new Error('A central não forneceu o tópico em tempo real.');
  }
  const desktopTopicReply = await edgeRequest(`/v1/events/${eventId}/desktop-realtime-topic`);
  if (typeof desktopTopicReply.topic !== 'string' || desktopTopicReply.topic.length === 0) {
    throw new Error('A central não forneceu o tópico rápido entre computadores.');
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().endsWith('/cashier'));
  if (!page) throw new Error('O GTRZ System Mobile instalado não está aberto na porta de teste.');
  await page.evaluate(() => {
    const testWindow = window;
    testWindow.__gtrzLiveRenderStartedAt = null;
    testWindow.__gtrzLiveRenderElapsedMs = null;
    const root = document.getElementById('app');
    if (!root) throw new Error('A interface mobile não possui a raiz do aplicativo.');
    new MutationObserver(() => {
      if (
        typeof testWindow.__gtrzLiveRenderStartedAt === 'number' &&
        testWindow.__gtrzLiveRenderElapsedMs === null
      ) {
        testWindow.__gtrzLiveRenderElapsedMs = Date.now() - testWindow.__gtrzLiveRenderStartedAt;
      }
    }).observe(root, { childList: true, subtree: true, characterData: true });
  });
  const mobileRefreshState = () =>
    page.evaluate(() => ({
      inFlight: state.realtimeRefreshInFlight,
      pending: state.realtimeRefreshPending,
      online: state.online,
    }));

  const protocol = await page.context().newCDPSession(page);
  await protocol.send('Network.enable');
  const milestones = [];
  let startedAt = null;
  protocol.on('Network.webSocketFrameReceived', ({ response }) => {
    if (startedAt !== null && response.payloadData.includes('state-changed')) {
      milestones.push({ step: 'sinal-websocket', elapsedMs: Date.now() - startedAt });
    }
  });
  protocol.on('Network.requestWillBeSent', ({ request }) => {
    const match = request.url.match(/\/v1\/mobile\/(session|catalog|context)/);
    if (startedAt !== null && match) {
      milestones.push({ step: match[1], elapsedMs: Date.now() - startedAt });
    }
  });

  const desktopReplica = createClient(projectUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let resolveBroadcast;
  let desktopBroadcastElapsedMs = null;
  const broadcastReceived = new Promise((resolve) => {
    resolveBroadcast = resolve;
  });
  const channel = desktopReplica
    .channel(topicReply.topic)
    .on('broadcast', { event: 'state-changed' }, ({ payload }) => {
      if (payload?.eventId === eventId) {
        desktopBroadcastElapsedMs = startedAt === null ? null : Date.now() - startedAt;
        resolveBroadcast();
      }
    });

  const desktopFastReplica = createClient(projectUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let resolveFastBroadcast;
  let desktopFastBroadcastElapsedMs = null;
  const fastBroadcastReceived = new Promise((resolve) => {
    resolveFastBroadcast = resolve;
  });
  const fastChannel = desktopFastReplica
    .channel(desktopTopicReply.topic)
    .on('broadcast', { event: 'journal-entry' }, ({ payload }) => {
      if (payload?.eventId === eventId && payload?.event?.sequence === 0) {
        desktopFastBroadcastElapsedMs = startedAt === null ? null : Date.now() - startedAt;
        resolveFastBroadcast();
      }
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
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Assinante rápido entre computadores não conectou em 10 segundos.')),
      10_000,
    );
    fastChannel.subscribe((status) => {
      if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) {
        clearTimeout(timeout);
        resolve();
      } else if (
        status === REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR ||
        status === REALTIME_SUBSCRIBE_STATES.TIMED_OUT
      ) {
        clearTimeout(timeout);
        reject(new Error(`Assinante rápido entre computadores: ${status}.`));
      }
    });
  });

  startedAt = Date.now();
  await page.evaluate((started) => {
    window.__gtrzLiveRenderStartedAt = started;
    window.__gtrzLiveRenderElapsedMs = null;
  }, startedAt);
  await edgeRequest('/v1/monitor/realtime-ping', {
    method: 'POST',
    body: JSON.stringify({ eventId }),
  });
  await Promise.race([
    broadcastReceived,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('O broadcast não chegou ao assinante do desktop.')),
        10_000,
      ),
    ),
  ]);

  const requiredSteps = ['sinal-websocket', 'session', 'catalog', 'context'];
  const deadline = Date.now() + 10_000;
  while (
    Date.now() < deadline &&
    !requiredSteps.every((step) => milestones.some((milestone) => milestone.step === step))
  ) {
    await wait(100);
  }

  const initialSettleDeadline = Date.now() + 12_000;
  let initialRefresh = await mobileRefreshState();
  while (
    Date.now() < initialSettleDeadline &&
    (initialRefresh.inFlight || initialRefresh.pending || !initialRefresh.online)
  ) {
    await wait(250);
    initialRefresh = await mobileRefreshState();
  }
  if (initialRefresh.inFlight || initialRefresh.pending || !initialRefresh.online) {
    throw new Error('A primeira atualização móvel não estabilizou antes do teste de rajada.');
  }
  const mobileVisualRenderElapsedMs = await page.evaluate(() => window.__gtrzLiveRenderElapsedMs);
  if (typeof mobileVisualRenderElapsedMs !== 'number') {
    throw new Error('A atualização em tempo real não gerou uma renderização visível no mobile.');
  }

  startedAt = Date.now();
  await edgeRequest('/v1/monitor/desktop-realtime-ping', {
    method: 'POST',
    body: JSON.stringify({ eventId }),
  });
  await Promise.race([
    fastBroadcastReceived,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('O canal rápido não chegou ao assinante do desktop.')),
        10_000,
      ),
    ),
  ]);

  await edgeRequest('/v1/monitor/realtime-ping', {
    method: 'POST',
    body: JSON.stringify({ eventId }),
  });
  await wait(500);
  const duringFirstRefresh = await mobileRefreshState();
  await edgeRequest('/v1/monitor/realtime-ping', {
    method: 'POST',
    body: JSON.stringify({ eventId }),
  });
  await wait(500);
  const afterSecondSignal = await mobileRefreshState();
  const settleDeadline = Date.now() + 12_000;
  let settledRefresh = await mobileRefreshState();
  while (
    Date.now() < settleDeadline &&
    (settledRefresh.inFlight || settledRefresh.pending || !settledRefresh.online)
  ) {
    await wait(250);
    settledRefresh = await mobileRefreshState();
  }

  await desktopReplica.removeChannel(channel);
  await desktopFastReplica.removeChannel(fastChannel);
  await protocol.detach();
  const missingSteps = requiredSteps.filter(
    (step) => !milestones.some((milestone) => milestone.step === step),
  );
  const burstCoalesced =
    duringFirstRefresh.inFlight &&
    afterSecondSignal.pending &&
    !settledRefresh.inFlight &&
    !settledRefresh.pending &&
    settledRefresh.online;
  console.log(
    JSON.stringify({
      simulator: 'installed',
      eventId,
      desktopReplicaReceived: true,
      desktopBroadcastElapsedMs,
      desktopFastBroadcastElapsedMs,
      mobileVisualRenderElapsedMs,
      milestones,
      burst: {
        duringFirstRefresh,
        afterSecondSignal,
        settledRefresh,
        coalesced: burstCoalesced,
      },
      passed: missingSteps.length === 0 && burstCoalesced,
      missingSteps,
    }),
  );
  process.exit(missingSteps.length === 0 && burstCoalesced ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
