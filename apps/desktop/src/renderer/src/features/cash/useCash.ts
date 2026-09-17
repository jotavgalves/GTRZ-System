import { useCallback, useEffect, useState } from 'react';

import type { CashState, RecordCashMovementInput } from '@gtrz/contracts';

import { useRealtimeReload } from '../../shared/realtime/useRealtimeReload';

interface CashViewState {
  readonly state: CashState | null;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly message: string | null;
  readonly reload: () => Promise<void>;
  readonly openRegister: (openingCashCents: number) => Promise<void>;
  readonly recordMovement: (input: RecordCashMovementInput) => Promise<void>;
  readonly closeRegister: (countedCashCents: number) => Promise<void>;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Não foi possível atualizar o caixa.';
}

export function useCash(): CashViewState {
  const [state, setState] = useState<CashState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async (silent = false): Promise<void> => {
    if (!silent) setLoading(true);
    setError(null);

    try {
      setState(await window.gtrz.cash.getState());
    } catch (loadError: unknown) {
      setError(getErrorMessage(loadError));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);
  useRealtimeReload(reload);

  const run = useCallback(
    async (operation: () => Promise<CashState>, successMessage: string): Promise<void> => {
      setBusy(true);
      setError(null);
      setMessage(null);

      try {
        setState(await operation());
        setMessage(successMessage);
      } catch (operationError: unknown) {
        setError(getErrorMessage(operationError));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const openRegister = useCallback(
    async (openingCashCents: number): Promise<void> => {
      await run(() => window.gtrz.cash.open({ openingCashCents }), 'Caixa aberto.');
    },
    [run],
  );

  const recordMovement = useCallback(
    async (input: RecordCashMovementInput): Promise<void> => {
      await run(
        () => window.gtrz.cash.recordMovement(input),
        input.type === 'supply' ? 'Suprimento registrado.' : 'Retirada registrada.',
      );
    },
    [run],
  );

  const closeRegister = useCallback(
    async (countedCashCents: number): Promise<void> => {
      await run(() => window.gtrz.cash.close({ countedCashCents }), 'Caixa fechado.');
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
    openRegister,
    recordMovement,
    closeRegister,
  };
}
