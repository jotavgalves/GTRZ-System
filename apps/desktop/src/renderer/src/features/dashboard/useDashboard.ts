import { useCallback, useEffect, useRef, useState } from 'react';

import type { DashboardState } from '@gtrz/contracts';

import { useRealtimeReload } from '../../shared/realtime/useRealtimeReload';
import { getCachedViewState, setCachedViewState } from '../../shared/navigation/view-state-cache';

interface DashboardViewState {
  readonly state: DashboardState | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly reload: () => Promise<void>;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Não foi possível carregar a visão geral.';
}

export function useDashboard(): DashboardViewState {
  const initialState = useRef(getCachedViewState<DashboardState>('dashboard')).current;
  const reloadGeneration = useRef(0);
  const [state, setState] = useState<DashboardState | null>(() => initialState);
  const [loading, setLoading] = useState(() => initialState === null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (silent = false): Promise<void> => {
    const generation = ++reloadGeneration.current;
    if (!silent) setLoading(true);
    setError(null);

    try {
      const nextState = await window.gtrz.dashboard.getState();
      if (generation !== reloadGeneration.current) return;
      setState(setCachedViewState('dashboard', nextState));
    } catch (loadError: unknown) {
      if (generation !== reloadGeneration.current) return;
      setError(getErrorMessage(loadError));
    } finally {
      if (!silent && generation === reloadGeneration.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload(initialState !== null);
  }, [initialState, reload]);
  useRealtimeReload(reload);

  return { state, loading, error, reload };
}
