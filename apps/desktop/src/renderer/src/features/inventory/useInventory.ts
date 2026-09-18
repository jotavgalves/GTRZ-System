import { useCallback, useEffect, useState } from 'react';

import type {
  CreateProductInput,
  DeleteProductInput,
  InventoryState,
  ProductDeletionImpact,
  RecordStockMovementInput,
  UpdateProductInput,
} from '@gtrz/contracts';

import { useRealtimeReload } from '../../shared/realtime/useRealtimeReload';

interface InventoryViewState {
  readonly state: InventoryState | null;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly message: string | null;
  readonly reload: () => Promise<void>;
  readonly createCategory: (name: string) => Promise<void>;
  readonly updateCategory: (categoryId: string, name: string) => Promise<void>;
  readonly deleteCategory: (categoryId: string) => Promise<void>;
  readonly createProduct: (input: CreateProductInput) => Promise<void>;
  readonly updateProduct: (input: UpdateProductInput) => Promise<void>;
  readonly recordMovement: (input: RecordStockMovementInput) => Promise<void>;
  readonly previewDeletion: (productId: string) => Promise<ProductDeletionImpact>;
  readonly deleteProduct: (input: DeleteProductInput) => Promise<void>;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Não foi possível atualizar o estoque.';
}

export function useInventory(): InventoryViewState {
  const [state, setState] = useState<InventoryState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async (silent = false): Promise<void> => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      setState(await window.gtrz.inventory.getState());
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
        const failureMessage = getErrorMessage(operationError);
        setError(failureMessage);
        throw new Error(failureMessage);
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  const createCategory = useCallback(
    async (name: string): Promise<void> => {
      await run(() => window.gtrz.inventory.createCategory({ name, engine: 'catalog' }), 'Categoria criada.');
    },
    [run],
  );
  const createProduct = useCallback(
    async (input: CreateProductInput): Promise<void> => {
      await run(() => window.gtrz.inventory.createProduct(input), 'Produto cadastrado.');
    },
    [run],
  );
  const updateCategory = useCallback(
    async (categoryId: string, name: string): Promise<void> => {
      await run(
        () => window.gtrz.inventory.updateCategory({ categoryId, name }),
        'Categoria atualizada.',
      );
    },
    [run],
  );
  const deleteCategory = useCallback(
    async (categoryId: string): Promise<void> => {
      await run(() => window.gtrz.inventory.deleteCategory({ categoryId }), 'Categoria excluída.');
    },
    [run],
  );
  const updateProduct = useCallback(
    async (input: UpdateProductInput): Promise<void> => {
      await run(() => window.gtrz.inventory.updateProduct(input), 'Produto atualizado.');
    },
    [run],
  );
  const recordMovement = useCallback(
    async (input: RecordStockMovementInput): Promise<void> => {
      await run(() => window.gtrz.inventory.recordMovement(input), 'Estoque atualizado.');
    },
    [run],
  );
  const previewDeletion = useCallback(async (productId: string): Promise<ProductDeletionImpact> => {
    return window.gtrz.inventory.previewDeletion(productId);
  }, []);
  const deleteProduct = useCallback(
    async (input: DeleteProductInput): Promise<void> => {
      await run(
        () => window.gtrz.inventory.deleteProduct(input),
        'Produto excluído definitivamente.',
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
    createCategory,
    updateCategory,
    deleteCategory,
    createProduct,
    updateProduct,
    recordMovement,
    previewDeletion,
    deleteProduct,
  };
}
