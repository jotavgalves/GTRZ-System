import { CalendarPlus, RefreshCw } from 'lucide-react';
import { useMemo, useState, type SyntheticEvent } from 'react';

import type { EventCloseResult, EventDeletionResult, EventStatus } from '@gtrz/contracts';

import { useSession } from '../../shared/session/session-context';
import { EventCard } from './EventCard';
import { EventClosePanel } from './EventClosePanel';
import { EventDeletePanel } from './EventDeletePanel';
import { useEvents } from './useEvents';

function getDefaultDateTime(): string {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

export function EventsPage(): React.JSX.Element {
  const { state: sessionState, refresh: refreshSession } = useSession();
  const {
    events,
    loading,
    error,
    create,
    rename,
    changeStatus,
    deletePermanently,
    select,
    reload,
  } = useEvents();
  const [name, setName] = useState('');
  const [startsAt, setStartsAt] = useState(getDefaultDateTime);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [closingEventId, setClosingEventId] = useState<string | null>(null);
  const [deletingEventId, setDeletingEventId] = useState<string | null>(null);
  const [closeMessage, setCloseMessage] = useState<string | null>(null);
  const [deleteMessage, setDeleteMessage] = useState<string | null>(null);
  if (loading && events.length === 0) {
    return <div className="route-state">Carregando eventos…</div>;
  }
  const activeEvent = sessionState?.activeEvent ?? null;
  const deletingEvent = events.find((event) => event.id === deletingEventId) ?? null;

  const counters = useMemo(
    () => ({
      open: events.filter((event) => event.status === 'open').length,
      closed: events.filter((event) => event.status === 'closed').length,
      archived: events.filter((event) => event.status === 'archived').length,
    }),
    [events],
  );

  async function handleCreate(formEvent: SyntheticEvent<HTMLFormElement>): Promise<void> {
    formEvent.preventDefault();
    setSubmitting(true);
    setFormError(null);

    try {
      const timestamp = new Date(startsAt).getTime();

      if (!Number.isFinite(timestamp)) {
        throw new Error('Informe uma data válida para o evento.');
      }

      await create(name, timestamp);
      setName('');
      setStartsAt(getDefaultDateTime());
    } catch (createError: unknown) {
      setFormError(
        createError instanceof Error ? createError.message : 'Não foi possível criar o evento.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function runEventAction(eventId: string, action: () => Promise<void>): Promise<void> {
    setBusyId(eventId);

    try {
      await action();
    } finally {
      setBusyId(null);
    }
  }

  async function handleStatus(eventId: string, status: EventStatus): Promise<void> {
    await runEventAction(eventId, () => changeStatus(eventId, status));
  }

  async function handleCloseCompleted(result: EventCloseResult): Promise<void> {
    setClosingEventId(null);
    setCloseMessage(`Evento encerrado. Backup verificado: ${result.backup.fileName}.`);
    await Promise.all([reload(), refreshSession()]);
  }

  async function handleDeleteCompleted(result: EventDeletionResult): Promise<void> {
    setDeletingEventId(null);
    setDeleteMessage(
      `${result.eventName} excluído definitivamente. Foram removidas ${String(result.removedOrdersCount)} comandas, ${String(result.removedExpensesCount)} despesas e ${String(result.removedStockMovementsCount)} movimentações de estoque.`,
    );
    await Promise.all([reload(), refreshSession()]);
  }

  return (
    <section className="feature-page">
      <header className="feature-header">
        <div>
          <span className="eyebrow">Controle do sistema</span>
          <h1>Eventos</h1>
          <p>Separe estoque, vendas, caixa, vouchers e auditoria em operações independentes.</p>
        </div>
        <button
          className="button button--secondary"
          disabled={loading}
          onClick={() => {
            void reload();
          }}
          type="button"
        >
          <RefreshCw size={17} aria-hidden="true" />
          Atualizar
        </button>
      </header>

      <div className="summary-grid summary-grid--compact">
        <article className="summary-card">
          <span>Abertos</span>
          <strong>{counters.open}</strong>
        </article>
        <article className="summary-card">
          <span>Encerrados</span>
          <strong>{counters.closed}</strong>
        </article>
        <article className="summary-card">
          <span>Arquivados</span>
          <strong>{counters.archived}</strong>
        </article>
        <article className="summary-card summary-card--accent">
          <span>Em operação</span>
          <strong>{activeEvent?.name ?? 'Nenhum'}</strong>
        </article>
      </div>

      {closeMessage === null ? null : <div className="event-close-success">{closeMessage}</div>}
      {deleteMessage === null ? null : <div className="event-close-success">{deleteMessage}</div>}

      {activeEvent !== null && closingEventId === activeEvent.id ? (
        <EventClosePanel
          eventId={activeEvent.id}
          eventName={activeEvent.name}
          onCompleted={handleCloseCompleted}
        />
      ) : null}

      {deletingEvent === null ? null : (
        <EventDeletePanel
          eventId={deletingEvent.id}
          eventName={deletingEvent.name}
          onCancel={() => {
            setDeletingEventId(null);
          }}
          onCompleted={(result) => {
            void handleDeleteCompleted(result);
          }}
          onDelete={deletePermanently}
        />
      )}

      <div className="control-layout">
        <form className="panel form-panel" onSubmit={(formEvent) => void handleCreate(formEvent)}>
          <div className="panel__heading">
            <CalendarPlus size={20} aria-hidden="true" />
            <div>
              <h2>Novo evento</h2>
              <p>O primeiro evento criado será selecionado automaticamente.</p>
            </div>
          </div>

          <label className="form-field">
            <span>Nome do evento</span>
            <input
              maxLength={100}
              minLength={2}
              onChange={(inputEvent) => {
                setName(inputEvent.target.value);
              }}
              placeholder="Ex.: La Rumba Neon — Agosto"
              required
              value={name}
            />
          </label>

          <label className="form-field">
            <span>Data e horário</span>
            <input
              onChange={(inputEvent) => {
                setStartsAt(inputEvent.target.value);
              }}
              required
              type="datetime-local"
              value={startsAt}
            />
          </label>

          {formError === null ? null : <p className="form-error">{formError}</p>}

          <button
            className="button button--primary"
            disabled={submitting || name.trim().length < 2}
            type="submit"
          >
            <CalendarPlus size={17} aria-hidden="true" />
            Criar evento
          </button>
        </form>

        <div className="event-list" aria-live="polite">
          {loading ? <div className="route-state">Carregando eventos…</div> : null}
          {!loading && error !== null ? (
            <div className="route-state route-state--error">{error}</div>
          ) : null}
          {!loading && error === null && events.length === 0 ? (
            <div className="empty-state">
              <CalendarPlus size={32} aria-hidden="true" />
              <h2>Nenhum evento cadastrado</h2>
              <p>Crie o primeiro evento para liberar a operação.</p>
            </div>
          ) : null}
          {events.map((event) => (
            <EventCard
              busy={busyId === event.id}
              event={event}
              isActive={activeEvent?.id === event.id}
              key={event.id}
              onChangeStatus={(eventId, status) => handleStatus(eventId, status)}
              onRename={(eventId, nextName) =>
                runEventAction(eventId, () => rename(eventId, nextName))
              }
              onRequestClose={(eventId) => {
                setCloseMessage(null);
                setDeleteMessage(null);
                setDeletingEventId(null);
                setClosingEventId(eventId);
              }}
              onRequestDelete={(eventId) => {
                setCloseMessage(null);
                setDeleteMessage(null);
                setClosingEventId(null);
                setDeletingEventId(eventId);
              }}
              onSelect={(eventId) => runEventAction(eventId, () => select(eventId))}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
