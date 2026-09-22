import { CalendarDays } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { GtrzEvent } from '@gtrz/contracts';

import { useSession } from '../../shared/session/session-context';

export function CloudEventSelector(): React.JSX.Element {
  const { state, setActiveEvent } = useSession();
  const [events, setEvents] = useState<readonly GtrzEvent[]>([]);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.gtrz.events
      .list()
      .then(setEvents)
      .catch(() => setEvents([]));
  }, [state?.activeEvent?.id]);

  const changeEvent = async (eventId: string): Promise<void> => {
    setSwitching(true);
    setError(null);
    try {
      await setActiveEvent(eventId);
    } catch (changeError: unknown) {
      setError(
        changeError instanceof Error ? changeError.message : 'Não foi possível trocar o evento.',
      );
    } finally {
      setSwitching(false);
    }
  };

  return (
    <section className="cloud-event panel" aria-label="Evento sincronizado">
      <CalendarDays size={20} aria-hidden="true" />
      <div className="cloud-event__copy">
        <span className="eyebrow">Evento sincronizado</span>
        <strong>{state?.activeEvent?.name ?? 'Nenhum evento ativo'}</strong>
        <small>As vendas móveis e os PCs usam o evento selecionado neste computador.</small>
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
    </section>
  );
}
