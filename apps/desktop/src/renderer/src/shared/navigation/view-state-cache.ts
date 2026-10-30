const viewStates = new Map<string, unknown>();

// Callers supply the cached view type; the map intentionally stores heterogeneous values.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function getCachedViewState<T>(key: string): T | null {
  return (viewStates.get(key) as T | undefined) ?? null;
}

export function setCachedViewState<T>(key: string, state: T): T {
  viewStates.set(key, state);
  return state;
}

export async function preloadViewState<T>(key: string, load: () => Promise<T>): Promise<T> {
  const cached = getCachedViewState<T>(key);
  if (cached !== null) {
    return cached;
  }

  return setCachedViewState(key, await load());
}
