import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  CloseOrderInput,
  ComboComponentSelection,
  OperationCatalogItem,
  OperationState,
  Order,
  ServicePoint,
  DeleteServicePointInput,
} from '@gtrz/contracts';

import { useRealtimeReload } from '../../shared/realtime/useRealtimeReload';
import { getCachedViewState, setCachedViewState } from '../../shared/navigation/view-state-cache';

interface OperationsViewState {
  readonly state: OperationState | null;
  readonly order: Order | null;
  readonly selectedServicePoint: ServicePoint | null;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly message: string | null;
  readonly reload: () => Promise<void>;
  readonly createTable: (label: string) => Promise<void>;
  readonly renameServicePoint: (servicePointId: string, label: string) => Promise<void>;
  readonly setServicePointPinned: (servicePointId: string, pinned: boolean) => Promise<void>;
  readonly deleteServicePoint: (input: DeleteServicePointInput) => Promise<void>;
  readonly openServicePoint: (servicePoint: ServicePoint) => Promise<void>;
  readonly addItem: (
    item: OperationCatalogItem,
    componentSelections?: readonly ComboComponentSelection[],
  ) => Promise<void>;
  readonly removeItem: (orderItemId: string) => Promise<void>;
  readonly bindVoucher: (code: string) => Promise<void>;
  readonly unbindVoucher: () => Promise<void>;
  readonly closeCurrentOrder: (input: Omit<CloseOrderInput, 'orderId'>) => Promise<void>;
  readonly cancelOrder: (orderId: string, reason: string) => Promise<void>;
  readonly reprintOrder: (orderId: string) => Promise<void>;
  readonly clearOrder: () => void;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Não foi possível concluir a operação.';
}

export function useOperations(): OperationsViewState {
  const initialState = useRef(getCachedViewState<OperationState>('operations')).current;
  const [state, setState] = useState<OperationState | null>(() => initialState);
  const [order, setOrder] = useState<Order | null>(null);
  const [selectedServicePoint, setSelectedServicePoint] = useState<ServicePoint | null>(null);
  const [loading, setLoading] = useState(() => initialState === null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async (silent = false): Promise<void> => {
    if (!silent) setLoading(true);
    setError(null);

    try {
      const nextState = await window.gtrz.operations.getState();
      setState(setCachedViewState('operations', nextState));
      setSelectedServicePoint((current) => {
        if (current === null) return null;
        return nextState.servicePoints.find((item) => item.id === current.id) ?? null;
      });
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
    async <T>(operation: () => Promise<T>, successMessage?: string): Promise<T> => {
      setBusy(true);
      setError(null);
      setMessage(null);

      try {
        const result = await operation();
        await reload();

        if (successMessage !== undefined) {
          setMessage(successMessage);
        }

        return result;
      } catch (operationError: unknown) {
        const failureMessage = getErrorMessage(operationError);
        setError(failureMessage);
        throw new Error(failureMessage);
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  const createTable = useCallback(
    async (label: string): Promise<void> => {
      await run(
        () => window.gtrz.operations.createServicePoint({ label, type: 'table' }),
        'Mesa criada.',
      );
    },
    [run],
  );

  const renameServicePoint = useCallback(
    async (servicePointId: string, label: string): Promise<void> => {
      const updated = await run(
        () => window.gtrz.operations.renameServicePoint({ servicePointId, label }),
        'Mesa renomeada.',
      );
      setSelectedServicePoint(updated);
      if (order?.servicePointId === servicePointId && order.status === 'open') {
        setOrder({ ...order, servicePointLabel: updated.label });
      }
    },
    [order, run],
  );

  const setServicePointPinned = useCallback(
    async (servicePointId: string, pinned: boolean): Promise<void> => {
      const updated = await run(
        () => window.gtrz.operations.setServicePointPinned({ servicePointId, pinned }),
        pinned ? 'Mesa fixada.' : 'Mesa desafixada.',
      );
      setSelectedServicePoint(updated);
    },
    [run],
  );

  const deleteServicePoint = useCallback(
    async (input: DeleteServicePointInput): Promise<void> => {
      await run(
        () => window.gtrz.operations.deleteServicePoint(input),
        input.mode === 'delete-all'
          ? 'Mesa excluída com estorno das compras e vouchers.'
          : 'Mesa excluída mantendo vendas concluídas.',
      );
      if (selectedServicePoint?.id === input.servicePointId) {
        setOrder(null);
        setSelectedServicePoint(null);
      }
    },
    [run, selectedServicePoint?.id],
  );

  const openServicePoint = useCallback(
    async (servicePoint: ServicePoint): Promise<void> => {
      setSelectedServicePoint(servicePoint);
      setError(null);
      setMessage(null);
      const activeOrderId = servicePoint.activeOrderId;

      if (activeOrderId === null) {
        setOrder(null);
        return;
      }

      const selected = await run(() => window.gtrz.operations.getOrder(activeOrderId));
      setOrder(selected);
    },
    [run],
  );

  const addItem = useCallback(
    async (
      item: OperationCatalogItem,
      componentSelections?: readonly ComboComponentSelection[],
    ): Promise<void> => {
      if (selectedServicePoint === null) {
        throw new Error('Selecione uma mesa ou o balcão antes de adicionar itens.');
      }

      const updated = await run(() =>
        order === null
          ? window.gtrz.operations.startOrderWithItem({
              servicePointId: selectedServicePoint.id,
              itemKind: item.kind,
              itemId: item.id,
              quantity: 1,
              ...(componentSelections === undefined
                ? {}
                : { componentSelections: [...componentSelections] }),
            })
          : window.gtrz.operations.addItem({
              orderId: order.id,
              itemKind: item.kind,
              itemId: item.id,
              quantity: 1,
              ...(componentSelections === undefined
                ? {}
                : { componentSelections: [...componentSelections] }),
            }),
      );
      setOrder(updated);
    },
    [order, run, selectedServicePoint],
  );

  const removeItem = useCallback(
    async (orderItemId: string): Promise<void> => {
      if (order === null) return;

      const updated = await run(() =>
        window.gtrz.operations.removeItem({ orderId: order.id, orderItemId }),
      );
      setOrder(updated);
    },
    [order, run],
  );

  const bindVoucher = useCallback(
    async (code: string): Promise<void> => {
      if (order === null) {
        throw new Error('Adicione ao menos um item antes de vincular um voucher.');
      }

      const updated = await run(
        () => window.gtrz.operations.bindVoucher({ orderId: order.id, code }),
        'Voucher vinculado à comanda.',
      );
      setOrder(updated);
    },
    [order, run],
  );

  const unbindVoucher = useCallback(async (): Promise<void> => {
    if (!order?.voucherAllocation) return;

    const updated = await run(
      () => window.gtrz.operations.unbindVoucher({ orderId: order.id }),
      'Voucher removido da comanda.',
    );
    setOrder(updated);
  }, [order, run]);

  const closeCurrentOrder = useCallback(
    async (input: Omit<CloseOrderInput, 'orderId'>): Promise<void> => {
      if (order === null) {
        throw new Error('Nenhuma comanda está aberta.');
      }

      await run(
        () => window.gtrz.operations.closeOrder({ orderId: order.id, ...input }),
        'Venda concluída e estoque atualizado.',
      );
      setOrder(null);
    },
    [order, run],
  );

  const cancelOrder = useCallback(
    async (orderId: string, reason: string): Promise<void> => {
      const paidOrder = state?.recentOrders.find((candidate) => candidate.id === orderId);
      const refunds =
        paidOrder?.status === 'paid'
          ? paidOrder.payments.map((payment) => ({
              method: payment.method,
              amountCents: payment.amountCents,
            }))
          : undefined;
      await run(
        () =>
          window.gtrz.operations.cancelOrder({
            orderId,
            reason,
            ...(refunds === undefined ? {} : { refunds }),
          }),
        'Comanda cancelada e operação auditada.',
      );

      if (order?.id === orderId) {
        setOrder(null);
        setSelectedServicePoint(null);
      }
    },
    [order?.id, run, state?.recentOrders],
  );

  const reprintOrder = useCallback(async (orderId: string): Promise<void> => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await window.gtrz.printing.reprintOrder({ orderId });
      if (!result.success) {
        setError(result.message);
        return;
      }
      setMessage(result.message);
    } catch (printError: unknown) {
      setError(getErrorMessage(printError));
    } finally {
      setBusy(false);
    }
  }, []);

  const clearOrder = useCallback((): void => {
    setOrder(null);
    setSelectedServicePoint(null);
    setError(null);
  }, []);

  return {
    state,
    order,
    selectedServicePoint,
    loading,
    busy,
    error,
    message,
    reload,
    createTable,
    renameServicePoint,
    setServicePointPinned,
    deleteServicePoint,
    openServicePoint,
    addItem,
    removeItem,
    bindVoucher,
    unbindVoucher,
    closeCurrentOrder,
    cancelOrder,
    reprintOrder,
    clearOrder,
  };
}
