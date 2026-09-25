import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  CreateExpenseInput,
  ExpenseState,
  RecordExpensePaymentInput,
  UpdateExpenseInput,
} from '@gtrz/contracts';

import { useRealtimeReload } from '../../shared/realtime/useRealtimeReload';
import { getCachedViewState, setCachedViewState } from '../../shared/navigation/view-state-cache';

interface ExpenseViewState {
  readonly state: ExpenseState | null;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly message: string | null;
  readonly reload: () => Promise<void>;
  readonly createExpense: (input: CreateExpenseInput) => Promise<void>;
  readonly updateExpense: (input: UpdateExpenseInput) => Promise<void>;
  readonly recordPayment: (input: RecordExpensePaymentInput) => Promise<void>;
  readonly cancelExpense: (expenseId: string, reason: string) => Promise<void>;
  readonly deleteExpense: (expenseId: string, reason: string) => Promise<void>;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Não foi possível atualizar as despesas.';
}

export function useExpenses(): ExpenseViewState {
  const initialState = useRef(getCachedViewState<ExpenseState>('expenses')).current;
  const [state, setState] = useState<ExpenseState | null>(() => initialState);
  const [loading, setLoading] = useState(() => initialState === null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async (silent = false): Promise<void> => {
    if (!silent) setLoading(true);
    setError(null);

    try {
      setState(setCachedViewState('expenses', await window.gtrz.expenses.getState()));
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

  const createExpense = useCallback(
    async (input: CreateExpenseInput): Promise<void> => {
      await run(() => window.gtrz.expenses.create(input), 'Despesa registrada.');
    },
    [run],
  );

  const recordPayment = useCallback(
    async (input: RecordExpensePaymentInput): Promise<void> => {
      await run(
        () => window.gtrz.expenses.recordPayment(input),
        'Pagamento registrado no livro financeiro.',
      );
    },
    [run],
  );

  const updateExpense = useCallback(
    async (input: UpdateExpenseInput): Promise<void> => {
      await run(() => window.gtrz.expenses.update(input), 'Despesa editada.');
    },
    [run],
  );

  const cancelExpense = useCallback(
    async (expenseId: string, reason: string): Promise<void> => {
      await run(() => window.gtrz.expenses.cancel({ expenseId, reason }), 'Despesa cancelada.');
    },
    [run],
  );

  const deleteExpense = useCallback(
    async (expenseId: string, reason: string): Promise<void> => {
      await run(
        () => window.gtrz.expenses.delete({ expenseId, reason }),
        'Despesa excluída definitivamente.',
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
    createExpense,
    updateExpense,
    recordPayment,
    cancelExpense,
    deleteExpense,
  };
}
