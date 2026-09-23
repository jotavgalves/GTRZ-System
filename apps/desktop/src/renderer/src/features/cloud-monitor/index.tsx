import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  Cloud,
  Laptop,
  RefreshCw,
  Server,
  Wifi,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { CloudMonitor } from '@gtrz/contracts';

import { MobileOperatorsPanel } from './MobileOperatorsPanel';
import { CloudEventSelector } from './CloudEventSelector';
import { EnvironmentSelector } from './EnvironmentSelector';

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(timestamp);
}

function shortDeviceId(deviceId: string): string {
  return deviceId.slice(0, 8).toUpperCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function money(cents: number | null): string {
  if (cents === null) return '—';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
}

function commandLabel(action: string): string {
  const labels: Readonly<Record<string, string>> = {
    'operations.order-paid': 'Venda confirmada',
    'inventory.stock-moved': 'Estoque movimentado',
    'inventory.product-created': 'Produto cadastrado',
    'inventory.product-updated': 'Produto atualizado',
    'inventory.purchase-lot-corrected': 'Custo de lote corrigido',
    'cashier.sale-rejected': 'Venda corrigida',
    'event.created': 'Evento criado',
    'expense.created': 'Despesa registrada',
    'expense.payment-recorded': 'Pagamento de despesa',
    'operations.order-cancelled': 'Venda estornada',
    'capital.contribution-created': 'Aporte registrado',
    'capital.contribution-updated': 'Estoque remanescente atualizado',
    'capital.reimbursed': 'Reembolso de aporte',
    'cash.opened': 'Caixa aberto',
    'cash.closed': 'Caixa fechado',
  };
  return labels[action] ?? action.replaceAll('.', ' · ');
}

interface CommandPresentation {
  readonly source: string;
  readonly summary: string;
  readonly chips: readonly string[];
}

function presentCommand(
  command: CloudMonitor['recentCommands'][number],
  labels: ReadonlyMap<string, string>,
): CommandPresentation {
  const details = isRecord(command.payload.details) ? command.payload.details : {};
  const profile = text(command.payload.profile);
  const mobileOperatorName = text(details.operatorName);
  const source =
    mobileOperatorName ??
    labels.get(command.deviceId) ??
    (profile === 'cashier' ? 'Caixa mobile' : `Dispositivo ${shortDeviceId(command.deviceId)}`);

  if (command.action === 'inventory.stock-moved') {
    const product =
      text(details.productLabel) ?? text(details.productName) ?? 'Produto sem identificação';
    const delta = number(details.delta);
    const before = number(details.beforeQuantity);
    const after = number(details.afterQuantity);
    const movement =
      delta === null
        ? 'movimentou o estoque'
        : `${delta > 0 ? 'adicionou' : 'baixou'} ${String(Math.abs(delta))} unidade${Math.abs(delta) === 1 ? '' : 's'}`;
    return {
      source,
      summary: `${source} ${movement} de ${product}.`,
      chips: [
        before === null || after === null
          ? 'Saldo não informado'
          : `Saldo: ${String(before)} para ${String(after)}`,
      ],
    };
  }

  if (command.action === 'inventory.purchase-lot-corrected') {
    return {
      source,
      summary: `${source} corrigiu o custo de um lote para ${money(number(details.totalCostCents))}.`,
      chips: [text(details.reason) ?? 'Motivo não informado'],
    };
  }

  if (command.action === 'operations.order-paid') {
    const order = isRecord(details.order) ? details.order : {};
    const point = text(order.servicePointLabel) ?? source;
    const items = Array.isArray(details.items) ? details.items.filter(isRecord) : [];
    const chips = items.map((item) => {
      const itemName = text(item.itemName) ?? 'Item';
      const quantity = number(item.quantity) ?? 0;
      return `${itemName} x${String(quantity)}`;
    });
    return {
      source,
      summary: `Venda recebida de ${point}. Total ${money(number(details.totalCents))}.`,
      chips,
    };
  }

  if (command.action === 'cashier.sale-rejected') {
    return {
      source,
      summary: 'A central corrigiu uma venda que não foi aplicada na cópia local.',
      chips: [],
    };
  }

  if (command.action === 'expense.payment-recorded') {
    return {
      source,
      summary: `${source} pagou ${text(details.description) ?? 'uma despesa'} em ${money(number(details.amountCents))}.`,
      chips: [text(details.method) ?? 'Meio não informado'],
    };
  }

  if (command.action === 'capital.contribution-created') {
    return {
      source,
      summary: `${source} registrou o aporte de ${text(details.contributorName) ?? 'responsável'}: ${money(number(details.amountCents))}.`,
      chips: [
        text(details.kind) === 'inventory'
          ? `Estoque remanescente: ${money(number(details.remainingStockValueCents))}`
          : 'Aporte em dinheiro',
      ],
    };
  }

  if (command.action === 'capital.reimbursed') {
    return {
      source,
      summary: `${source} registrou reembolso prioritário de ${money(number(details.amountCents))}.`,
      chips: [text(details.contributorName) ?? 'Responsável do aporte'],
    };
  }

  if (command.action === 'operations.order-cancelled') {
    return {
      source,
      summary: `${source} estornou uma venda e devolveu o estoque correspondente.`,
      chips: [`Devolução: ${money(number(details.totalCents))}`],
    };
  }

  return {
    source,
    summary: `${source} registrou ${commandLabel(command.action).toLowerCase()}.`,
    chips: [],
  };
}

export function CloudMonitorPage(): React.JSX.Element {
  const [monitor, setMonitor] = useState<CloudMonitor | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setMonitor(await window.gtrz.settings.getCloudMonitor());
      setError(null);
    } catch (loadError: unknown) {
      setError(
        loadError instanceof Error ? loadError.message : 'Não foi possível consultar a nuvem.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const averageLatency =
    monitor === null || monitor.activeDevices.length === 0
      ? null
      : Math.round(
          monitor.activeDevices.reduce((total, device) => total + device.latencyMs, 0) /
            monitor.activeDevices.length,
        );

  const deviceLabels = new Map(monitor?.activeDevices.map((device) => [device.id, device.label]));

  return (
    <section className="module-page cloud-monitor-page">
      <header className="module-page__header">
        <div>
          <span className="eyebrow">Cloudflare · canal autenticado</span>
          <h1>Nuvem em tempo real</h1>
          <p>Presença, comandos idempotentes e fila SQLite deste computador.</p>
        </div>
        <button
          className="button button--ghost"
          disabled={loading}
          onClick={() => void load()}
          type="button"
        >
          <RefreshCw size={17} aria-hidden="true" />
          Atualizar
        </button>
      </header>

      {error === null ? null : <p className="form-error">{error}</p>}

      <EnvironmentSelector />
      <CloudEventSelector />

      <div className="cloud-monitor-summary">
        <article className="panel cloud-metric">
          <span className="cloud-metric__icon cloud-metric__icon--success" aria-hidden="true">
            <Wifi size={21} />
          </span>
          <div>
            <span>Dispositivos ativos</span>
            <strong>{monitor?.activeDevices.length ?? 0}</strong>
            <small>Atualização automática a cada 5 segundos</small>
          </div>
        </article>
        <article className="panel cloud-metric">
          <span className="cloud-metric__icon cloud-metric__icon--brand" aria-hidden="true">
            <Activity size={21} />
          </span>
          <div>
            <span>Idempotência</span>
            <strong>{monitor?.idempotency.acceptedCommands ?? 0}</strong>
            <small>{`${String(monitor?.idempotency.replayedAttempts ?? 0)} replays sem duplicar dados`}</small>
          </div>
        </article>
        <article className="panel cloud-metric">
          <span className="cloud-metric__icon" aria-hidden="true">
            <ArrowUpFromLine size={21} />
          </span>
          <div>
            <span>Fila para enviar</span>
            <strong>{monitor?.localQueue.outboxPending ?? 0}</strong>
            <small>{`${String(monitor?.localQueue.outboxAccepted ?? 0)} comandos aceitos pela central`}</small>
          </div>
        </article>
        <article className="panel cloud-metric">
          <span className="cloud-metric__icon" aria-hidden="true">
            <Activity size={21} />
          </span>
          <div>
            <span>Latência média</span>
            <strong>{averageLatency === null ? '—' : `${String(averageLatency)} ms`}</strong>
            <small>Ida e volta medida pelo aplicativo</small>
          </div>
        </article>
        <article className="panel cloud-metric">
          <span className="cloud-metric__icon cloud-metric__icon--brand" aria-hidden="true">
            <Cloud size={21} />
          </span>
          <div>
            <span>Central</span>
            <strong>{error === null ? 'Online' : 'Indisponível'}</strong>
            <small>{monitor?.endpoint ?? 'Cloudflare Worker'}</small>
          </div>
        </article>
      </div>

      <section className="cloud-flow" aria-label="Fluxo da nuvem">
        <div className="cloud-flow__node">
          <Laptop size={23} aria-hidden="true" />
          <strong>SQLite local</strong>
          <span>{`${String(monitor?.localQueue.outboxPending ?? 0)} aguardando envio`}</span>
        </div>
        <div className="cloud-flow__line" aria-hidden="true">
          <span />
        </div>
        <div className="cloud-flow__node cloud-flow__node--central">
          <Server size={24} aria-hidden="true" />
          <strong>Cloudflare</strong>
          <span>Diário idempotente</span>
        </div>
        <div className="cloud-flow__line" aria-hidden="true">
          <span />
        </div>
        <div className="cloud-flow__node">
          <Laptop size={23} aria-hidden="true" />
          <strong>Outros computadores</strong>
          <span>{`${String(monitor?.localQueue.inboxReceived ?? 0)} eventos recebidos`}</span>
        </div>
      </section>

      <div className="cloud-monitor-grid">
        <section className="panel cloud-device-panel">
          <div className="panel__heading">
            <Laptop size={20} aria-hidden="true" />
            <div>
              <h2>Máquinas conectadas</h2>
              <p>Uma máquina desaparece da lista após 45 segundos sem sinal.</p>
            </div>
          </div>
          <div className="cloud-device-list">
            {monitor?.activeDevices.map((device) => (
              <article className="cloud-device-row" key={device.id}>
                <span className="cloud-device-row__signal" aria-hidden="true" />
                <div>
                  <strong>{device.label}</strong>
                  <small>{`ID ${shortDeviceId(device.id)} · visto ${formatTime(device.lastSeenAt)}`}</small>
                </div>
                <span>{`${String(device.latencyMs)} ms`}</span>
              </article>
            )) ?? <p className="cloud-empty">Nenhum dispositivo respondeu ainda.</p>}
          </div>
        </section>

        <section className="panel cloud-flow-panel">
          <div className="panel__heading">
            <Activity size={20} aria-hidden="true" />
            <div>
              <h2>Comandos confirmados</h2>
              <p>Diário central. Repetir o mesmo comando não cria outra alteração.</p>
            </div>
          </div>
          <div className="cloud-flow-list cloud-flow-list--scroll">
            {monitor?.recentCommands.map((command) => {
              const presentation = presentCommand(command, deviceLabels);
              return (
                <article className="cloud-command-row" key={command.commandId}>
                  <span className="cloud-flow-row__pulse" aria-hidden="true" />
                  <div className="cloud-command-row__content">
                    <div className="cloud-command-row__topline">
                      <div>
                        <strong>{commandLabel(command.action)}</strong>
                        <small>{`${presentation.source} · evento ${shortDeviceId(command.eventId)}`}</small>
                      </div>
                      <time>{formatTime(command.createdAt)}</time>
                    </div>
                    <p>{presentation.summary}</p>
                    {presentation.chips.length === 0 ? null : (
                      <div className="cloud-command-row__chips">
                        {presentation.chips.map((chip, index) => (
                          <span key={`${command.commandId}-${String(index)}`}>{chip}</span>
                        ))}
                      </div>
                    )}
                    <details className="cloud-command-row__technical">
                      <summary>Dados técnicos e códigos</summary>
                      <pre>
                        {JSON.stringify(
                          {
                            commandId: command.commandId,
                            auditId: command.auditId,
                            deviceId: command.deviceId,
                            payload: command.payload,
                          },
                          null,
                          2,
                        )}
                      </pre>
                    </details>
                  </div>
                </article>
              );
            }) ?? <p className="cloud-empty">Aguardando o primeiro comando confirmado.</p>}
          </div>
        </section>
      </div>

      <MobileOperatorsPanel />

      <section className="panel cloud-flow-panel">
        <div className="panel__heading">
          <Activity size={20} aria-hidden="true" />
          <div>
            <h2>Transporte confirmado</h2>
            <p>Subidas pelo diário e entregas WebSocket registradas pela central.</p>
          </div>
        </div>
        <div className="cloud-flow-list cloud-flow-list--scroll">
          {monitor?.recentTransport.map((transport) => (
            <article className="cloud-flow-row" key={transport.sequence}>
              <span className="cloud-flow-row__pulse" aria-hidden="true" />
              <div>
                <strong>{`${transport.direction === 'up' ? 'PC → central' : 'central → PC'} · ${transport.transport}`}</strong>
                <small>{`${transport.action} · ${shortDeviceId(transport.deviceId)}`}</small>
              </div>
              <time>{formatTime(transport.createdAt)}</time>
            </article>
          )) ?? <p className="cloud-empty">Aguardando transporte confirmado.</p>}
        </div>
      </section>

      <section className="panel cloud-flow-panel">
        <div className="panel__heading">
          <Activity size={20} aria-hidden="true" />
          <div>
            <h2>Conflitos reportados pela central</h2>
            <p>
              Ocorrências de qualquer computador que exigem decisão humana antes de alterar os
              dados.
            </p>
          </div>
        </div>
        <div className="cloud-flow-list">
          {monitor?.recentConflicts.map((conflict) => (
            <article className="cloud-flow-row" key={conflict.sequence}>
              <span className="cloud-flow-row__pulse" aria-hidden="true" />
              <div>
                <strong>{conflict.action}</strong>
                <small>{`${conflict.reason} · PC ${shortDeviceId(conflict.deviceId)} · evento ${shortDeviceId(conflict.eventId)}`}</small>
              </div>
              <time>{formatTime(conflict.createdAt)}</time>
            </article>
          )) ?? <p className="cloud-empty">Nenhum conflito foi reportado pela central.</p>}
        </div>
      </section>

      <section className="panel cloud-queue-panel">
        <div className="panel__heading">
          <ArrowDownToLine size={20} aria-hidden="true" />
          <div>
            <h2>Réplica local e auditoria</h2>
            <p>
              O banco SQLite continua no computador. Eventos recebidos ficam preservados para
              conferência antes de qualquer ajuste automático.
            </p>
          </div>
        </div>
        <div className="cloud-queue-stats">
          <span>
            <b>{monitor?.localQueue.outboxFailed ?? 0}</b> com falha de envio
          </span>
          <span>
            <b>{monitor?.localQueue.inboxReceived ?? 0}</b> recebidos da central
          </span>
          <span>
            <b>{monitor?.localQueue.inboxAwaitingApply ?? 0}</b> aguardando aplicação/auditoria
          </span>
          <span>
            <b>{monitor?.localQueue.conflictsOpen ?? 0}</b> conflitos abertos para auditoria
          </span>
        </div>
      </section>

      <section className="panel cloud-flow-panel">
        <div className="panel__heading">
          <Activity size={20} aria-hidden="true" />
          <div>
            <h2>Conflitos para auditoria</h2>
            <p>
              Ocorrências que não foram alteradas automaticamente para preservar a verdade dos dois
              bancos.
            </p>
          </div>
        </div>
        <div className="cloud-flow-list">
          {monitor?.localConflicts.map((conflict) => (
            <article className="cloud-flow-row" key={conflict.commandId}>
              <span className="cloud-flow-row__pulse" aria-hidden="true" />
              <div>
                <strong>{conflict.action}</strong>
                <small>{`${conflict.reason} · evento ${shortDeviceId(conflict.eventId)}`}</small>
              </div>
              <time>{formatTime(conflict.createdAt)}</time>
            </article>
          )) ?? <p className="cloud-empty">Nenhum conflito em aberto.</p>}
        </div>
      </section>
    </section>
  );
}
