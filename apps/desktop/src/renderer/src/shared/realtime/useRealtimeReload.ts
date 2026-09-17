import { useEffect } from 'react';

/** Reloads a view after a remote transaction has been committed to local SQLite. */
export function useRealtimeReload(reload: (silent?: boolean) => Promise<void>): void {
  useEffect(() => {
    return window.gtrz.realtime.onDataChanged(() => {
      void reload(true);
    });
  }, [reload]);
}
