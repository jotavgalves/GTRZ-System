import { useCallback, useEffect, useState } from 'react';

import type {
  CreateExpenseInput,
  ExpensePaymentStatus,
  ExpenseState,
  UpdateExpenseInput,
} from '@gtrz/contracts';

import { useRealtimeReload } from '../../shared/realtime/useRealtimeReload';

interface ExpenseViewState {
  readonly state: ExpenseState | null;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly message: string | null;
  readonly reload: () => Promise<void>;
  readonly createExpense: (input: CreateExpenseInput) => Promise<void>;
  readonly updateExpense: (input: UpdateExpenseInput) => Promise<void>;
  readonly updatePaymentStatus: (
    expenseId: string,
    paymentStatus: ExpensePaymentStatus,
  ) => Promise<void>;
  readonly cancelExpense: (expenseId: string, reason: string) => Promise<void>;
  readonly deleteExpense: (expenseId: string, reason: string) => Promise<void>;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Não foi possível atualizar as despesas.';
}

export function useExpenses(): ExpenseViewState {
  const [state, setState] = useState<ExpenseState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async (silent = false): Promise<void> => {
    if (!silent) setLoading(true);
    setError(null);

    try {
      setState(await window.gtrz.expenses.getState());
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

  const updatePaymentStatus = useCallback(
    async (expenseId: string, paymentStatus: ExpensePaymentStatus): Promise<void> => {
      await run(
        () => window.gtrz.expenses.updatePaymentStatus({ expenseId, paymentStatus }),
        'Situação da despesa atualizada.',
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
    updatePaymentStatus,
    cancelExpense,
    deleteExpense,
  };
}
