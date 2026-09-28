const viewStates = new Map<string, unknown>();

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
