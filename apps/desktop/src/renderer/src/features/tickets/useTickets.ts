import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  CreateTicketLotInput,
  CreateTicketSaleInput,
  DeleteTicketLotInput,
  TicketState,
  UpdateTicketLotInput,
} from '@gtrz/contracts';

import { useRealtimeReload } from '../../shared/realtime/useRealtimeReload';
import { getCachedViewState, setCachedViewState } from '../../shared/navigation/view-state-cache';

interface TicketViewState {
  readonly state: TicketState | null;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly message: string | null;
  readonly reload: () => Promise<void>;
  readonly createLot: (input: CreateTicketLotInput) => Promise<void>;
  readonly updateLot: (input: UpdateTicketLotInput) => Promise<void>;
  readonly deleteLot: (input: DeleteTicketLotInput) => Promise<void>;
  readonly createSale: (input: CreateTicketSaleInput) => Promise<void>;
  readonly cancelSale: (saleId: string, reason: string) => Promise<void>;
  readonly deleteSale: (saleId: string, reason: string) => Promise<void>;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Não foi possível atualizar os ingressos.';
}

export function useTickets(): TicketViewState {
  const initialState = useRef(getCachedViewState<TicketState>('tickets')).current;
  const [state, setState] = useState<TicketState | null>(() => initialState);
  const [loading, setLoading] = useState(() => initialState === null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async (silent = false): Promise<void> => {
    if (!silent) setLoading(true);
    setError(null);

    try {
      setState(setCachedViewState('tickets', await window.gtrz.tickets.getState()));
    } catch (loadError: unknown) {
      setError(getErrorMessage(loadError));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload(initialState !== null);
  }, [initialState, reload]);
  useRealtimeReload(reload);

  const run = useCallback(
    async (operation: () => Promise<unknown>, successMessage: string): Promise<void> => {
      setBusy(true);
      setError(null);
      setMessage(null);

      try {
        await operation();
        await reload();
        setMessage(successMessage);
      } catch (operationError: unknown) {
        setError(getErrorMessage(operationError));
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  const createLot = useCallback(
    async (input: CreateTicketLotInput): Promise<void> => {
      await run(() => window.gtrz.tickets.createLot(input), 'Lote criado.');
    },
    [run],
  );

  const updateLot = useCallback(
    async (input: UpdateTicketLotInput): Promise<void> => {
      await run(() => window.gtrz.tickets.updateLot(input), 'Lote atualizado.');
    },
    [run],
  );

  const deleteLot = useCallback(
    async (input: DeleteTicketLotInput): Promise<void> => {
      await run(
        () => window.gtrz.tickets.deleteLot(input),
        'Lote, vendas e códigos excluídos definitivamente.',
      );
    },
    [run],
  );

  const createSale = useCallback(
    async (input: CreateTicketSaleInput): Promise<void> => {
      await run(() => window.gtrz.tickets.createSale(input), 'Ingressos registrados.');
    },
    [run],
  );

  const cancelSale = useCallback(
    async (saleId: string, reason: string): Promise<void> => {
      await run(() => window.gtrz.tickets.cancelSale({ saleId, reason }), 'Venda cancelada.');
    },
    [run],
  );

  const deleteSale = useCallback(
    async (saleId: string, reason: string): Promise<void> => {
      await run(
        () => window.gtrz.tickets.deleteSale({ saleId, reason }),
        'Venda e códigos excluídos definitivamente.',
      );
    },
    [run],
  );

  return {
    state,
    loading,
    busy,
    error,
    message,
    reload,
    createLot,
    updateLot,
    deleteLot,
    createSale,
    cancelSale,
    deleteSale,
  };
}
