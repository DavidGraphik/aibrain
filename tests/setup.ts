import "@testing-library/jest-dom/vitest";

// Recent Node releases expose an incomplete global `localStorage` unless the
// process receives `--localstorage-file`. That accessor can shadow jsdom's
// standards-compliant Storage object and make otherwise isolated component
// tests fail before rendering. Component tests need deterministic in-memory
// storage, never filesystem-backed process state.
if (typeof document !== "undefined") {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(String(key)) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(String(key)); },
    setItem: (key, value) => { values.set(String(key), String(value)); },
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    enumerable: true,
    value: storage,
  });

  // jsdom intentionally omits a canvas renderer. Returning `null` matches the
  // browser API's unsupported-context contract without printing a false error
  // for components that already provide a non-canvas fallback.
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => null,
  });
}
