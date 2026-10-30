import { useCallback, useEffect, useRef, useState } from 'react';

import type { AuditQueryInput, AuditState } from '@gtrz/contracts';

import { getCachedViewState, setCachedViewState } from '../../shared/navigation/view-state-cache';

interface AuditViewState {
  readonly state: AuditState | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly load: (input?: AuditQueryInput) => Promise<void>;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Não foi possível carregar a auditoria.';
}

export function useAudit(): AuditViewState {
  const initialState = useRef(getCachedViewState<AuditState>('audit')).current;
  const [state, setState] = useState<AuditState | null>(() => initialState);
  const [loading, setLoading] = useState(() => initialState === null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (input: AuditQueryInput = { limit: 100 }): Promise<void> => {
    setLoading(true);
    setError(null);

    try {
      const nextState = await window.gtrz.audit.list(input);
      setState(nextState);
      if (input.limit === 100 && Object.keys(input).length === 1) {
        setCachedViewState('audit', nextState);
      }
    } catch (loadError: unknown) {
      setError(getErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(initialState === null ? undefined : { limit: 100 });
  }, [initialState, load]);

  return { state, loading, error, load };
}
