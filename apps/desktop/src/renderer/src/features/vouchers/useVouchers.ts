import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  AddVoucherBalanceInput,
  CreateVoucherInput,
  DeleteVoucherInput,
  SetVoucherTotalInput,
  UpdateVoucherInput,
  VoucherState,
} from '@gtrz/contracts';

import { useRealtimeReload } from '../../shared/realtime/useRealtimeReload';
import { getCachedViewState, setCachedViewState } from '../../shared/navigation/view-state-cache';

interface VoucherViewState {
  readonly state: VoucherState | null;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly message: string | null;
  readonly reload: () => Promise<void>;
  readonly createVoucher: (input: CreateVoucherInput) => Promise<void>;
  readonly changeStatus: (voucherId: string, status: 'active' | 'cancelled') => Promise<void>;
  readonly updateVoucher: (input: UpdateVoucherInput) => Promise<void>;
  readonly addBalance: (input: AddVoucherBalanceInput) => Promise<void>;
  readonly setVoucherTotal: (input: SetVoucherTotalInput) => Promise<void>;
  readonly deleteVoucher: (input: DeleteVoucherInput) => Promise<void>;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Não foi possível atualizar os vouchers.';
}

export function useVouchers(): VoucherViewState {
  const initialState = useRef(getCachedViewState<VoucherState>('vouchers')).current;
  const [state, setState] = useState<VoucherState | null>(() => initialState);
  const [loading, setLoading] = useState(() => initialState === null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async (silent = false): Promise<void> => {
    if (!silent) setLoading(true);
    setError(null);

    try {
      setState(setCachedViewState('vouchers', await window.gtrz.vouchers.getState()));
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
        throw operationError;
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  const createVoucher = useCallback(
    async (input: CreateVoucherInput): Promise<void> => {
      await run(() => window.gtrz.vouchers.create(input), 'Voucher emitido e vinculado à mesa.');
    },
    [run],
  );

  const changeStatus = useCallback(
    async (voucherId: string, status: 'active' | 'cancelled'): Promise<void> => {
      await run(
        () => window.gtrz.vouchers.changeStatus({ voucherId, status }),
        status === 'active' ? 'Voucher reativado.' : 'Voucher cancelado.',
      );
    },
    [run],
  );

  const updateVoucher = useCallback(
    async (input: UpdateVoucherInput): Promise<void> => {
      await run(() => window.gtrz.vouchers.update(input), 'Voucher atualizado.');
    },
    [run],
  );

  const addBalance = useCallback(
    async (input: AddVoucherBalanceInput): Promise<void> => {
      await run(() => window.gtrz.vouchers.addBalance(input), 'Saldo adicionado ao voucher.');
    },
    [run],
  );

  const setVoucherTotal = useCallback(
    async (input: SetVoucherTotalInput): Promise<void> => {
      await run(() => window.gtrz.vouchers.setTotal(input), 'Valor total do voucher corrigido.');
    },
    [run],
  );

  const deleteVoucher = useCallback(
    async (input: DeleteVoucherInput): Promise<void> => {
      await run(async () => {
        const result = await window.gtrz.vouchers.delete(input);
        return result;
      }, 'Voucher excluído com segurança.');
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
    createVoucher,
    changeStatus,
    updateVoucher,
    addBalance,
    setVoucherTotal,
    deleteVoucher,
  };
}
