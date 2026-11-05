import { useCallback, useSyncExternalStore } from 'react';

/** Per-mounted workbench display buffer; never a module-global tenant store. */
export class LiveAnswerStore {
  private readonly values = new Map<string, string>();
  private readonly listeners = new Map<string, Set<() => void>>();
  key(threadId: string, messageId: string) { return `${threadId}:${messageId}`; }
  read(key: string) { return this.values.get(key) ?? null; }
  write(key: string, value: string) {
    if (this.read(key) === value) return;
    this.values.set(key, value);
    this.listeners.get(key)?.forEach(listener => listener());
  }
  subscribe(key: string, listener: () => void) {
    const listeners = this.listeners.get(key) ?? new Set();
    listeners.add(listener); this.listeners.set(key, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(key); };
  }
  retain(keys: Set<string>) {
    for (const key of this.values.keys()) if (!keys.has(key)) {
      this.values.delete(key); this.listeners.get(key)?.forEach(listener => listener());
    }
  }
}

export function useLiveAnswer(store: LiveAnswerStore | undefined, key: string) {
  const subscribe = useCallback((listener: () => void) => store?.subscribe(key, listener) ?? (() => {}), [store, key]);
  const snapshot = useCallback(() => store?.read(key) ?? null, [store, key]);
  return useSyncExternalStore(subscribe, snapshot, () => null);
}
