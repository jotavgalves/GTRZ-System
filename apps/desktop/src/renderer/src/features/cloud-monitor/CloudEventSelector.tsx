import { AlertTriangle, CalendarDays } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { GtrzEvent } from '@gtrz/contracts';

import { useSession } from '../../shared/session/session-context';

export function CloudEventSelector(): React.JSX.Element {
  const { state, refresh } = useSession();
  const [events, setEvents] = useState<readonly GtrzEvent[]>([]);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmationName, setConfirmationName] = useState('');
  const [reason, setReason] = useState('');
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    void window.gtrz.events
      .list()
      .then(setEvents)
      .catch(() => {
        setEvents([]);
      });
  }, [state?.activeEvent?.id]);

  const changeEvent = async (eventId: string): Promise<void> => {
    setSwitching(true);
    setError(null);
    try {
      await window.gtrz.settings.setGlobalEvent({ eventId });
      await refresh();
    } catch (changeError: unknown) {
      setError(
        changeError instanceof Error ? changeError.message : 'Não foi possível trocar o evento.',
      );
    } finally {
      setSwitching(false);
    }
  };

  const resetEvent = async (): Promise<void> => {
    const event = state?.activeEvent;
    if (event === null || event === undefined) return;
    setResetting(true);
    setError(null);
    try {
      await window.gtrz.settings.resetGlobalEvent({
        eventId: event.id,
        confirmationName,
        reason,
      });
      setConfirmationName('');
      setReason('');
      await refresh();
    } catch (resetError: unknown) {
      setError(
        resetError instanceof Error ? resetError.message : 'Não foi possível zerar o evento.',
      );
    } finally {
      setResetting(false);
    }
  };

  return (
    <section className="cloud-event panel" aria-label="Evento sincronizado">
      <CalendarDays size={20} aria-hidden="true" />
      <div className="cloud-event__copy">
        <span className="eyebrow">Evento sincronizado</span>
        <strong>{state?.activeEvent?.name ?? 'Nenhum evento ativo'}</strong>
        <small>Este evento é aplicado a todos os PCs e caixas móveis conectados.</small>
      </div>
      <label className="cloud-event__select">
        <span className="sr-only">Trocar evento sincronizado</span>
        <select
          disabled={switching || events.length === 0}
          onChange={(event) => void changeEvent(event.target.value)}
          value={state?.activeEvent?.id ?? ''}
        >
          <option value="" disabled>
            Selecione um evento
          </option>
          {events
            .filter((event) => event.status === 'open')
            .map((event) => (
              <option key={event.id} value={event.id}>
                {event.name}
              </option>
            ))}
        </select>
      </label>
      {error === null ? null : <p className="form-error cloud-event__error">{error}</p>}
      {state?.activeEvent === null || state?.activeEvent === undefined ? null : (
        <details className="cloud-event__reset">
          <summary>
            <AlertTriangle size={16} aria-hidden="true" />
            Zerar dados deste evento em todos os dispositivos
          </summary>
          <p>
            Primeiro cada PC conectado cria um backup local e envia uma cópia verificada para a
            nuvem. A limpeza só acontece quando todos confirmarem. Ela apaga vendas, mesas,
            vouchers, despesas, ingressos, caixas e estoque; o evento e o catálogo permanecem.
          </p>
          <label>
            <span>{`Digite ${state.activeEvent.name} para confirmar`}</span>
            <input
              value={confirmationName}
              onChange={(event) => {
                setConfirmationName(event.target.value);
              }}
            />
          </label>
          <label>
            <span>Motivo da limpeza</span>
            <input
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
          </label>
          <button
            className="button button--danger"
            disabled={
              resetting || confirmationName !== state.activeEvent.name || reason.trim().length < 3
            }
            onClick={() => void resetEvent()}
            type="button"
          >
            {resetting
              ? 'Solicitando backups obrigatórios...'
              : 'Preparar backups e zerar o evento'}
          </button>
        </details>
      )}
    </section>
  );
}
