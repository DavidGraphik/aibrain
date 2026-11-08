import { registerHooks } from "node:module";

const stubUrl = new URL("./server-only-stub.mjs", import.meta.url).href;

// The standalone acceptance runner deliberately imports server-owned stores
// outside Next.js. Keep the production `server-only` marker intact while
// replacing only that marker in this isolated Node process.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        url: stubUrl,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
