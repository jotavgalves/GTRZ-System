import { useCallback, useEffect, useMemo, useState, type PropsWithChildren } from 'react';

import type { SessionState } from '@gtrz/contracts';

import { SessionContext, type SessionContextValue } from './session-context';

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Não foi possível atualizar a sessão.';
}

export function SessionProvider({ children }: PropsWithChildren): React.JSX.Element {
  const [state, setState] = useState<SessionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);

    try {
      setState(await window.gtrz.session.getState());
    } catch (refreshError: unknown) {
      setError(getErrorMessage(refreshError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    return window.gtrz.realtime.onDataChanged(() => {
      void window.gtrz.session
        .getState()
        .then(setState)
        .catch(() => undefined);
    });
  }, []);

  const setActiveEvent = useCallback(async (eventId: string | null): Promise<void> => {
    setError(null);

    try {
      setState(await window.gtrz.events.setActive({ eventId }));
    } catch (selectionError: unknown) {
      const message = getErrorMessage(selectionError);
      setError(message);
      throw new Error(message);
    }
  }, []);

  const switchToCashier = useCallback(async (): Promise<void> => {
    setError(null);

    try {
      setState(await window.gtrz.session.switchProfile({ targetProfile: 'cashier' }));
    } catch (switchError: unknown) {
      const message = getErrorMessage(switchError);
      setError(message);
      throw new Error(message);
    }
  }, []);

  const switchToProduction = useCallback(async (password: string): Promise<void> => {
    setError(null);

    try {
      setState(
        await window.gtrz.session.switchProfile({
          targetProfile: 'production',
          password,
        }),
      );
    } catch (switchError: unknown) {
      const message = getErrorMessage(switchError);
      setError(message);
      throw new Error(message);
    }
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({
      state,
      loading,
      error,
      refresh,
      setActiveEvent,
      switchToCashier,
      switchToProduction,
    }),
    [error, loading, refresh, setActiveEvent, state, switchToCashier, switchToProduction],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
