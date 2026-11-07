import "server-only";

import {
  createOperationalLogger,
  jsonLineOperationalLogSink,
} from "@/operations/logging";

const loggerGlobal = globalThis as typeof globalThis & {
  __aibrainOperationalLogger?: ReturnType<typeof createOperationalLogger>;
};

export const operationalLogger = loggerGlobal.__aibrainOperationalLogger ??= createOperationalLogger({
  sink: jsonLineOperationalLogSink(process.stderr),
  baseAttributes: { service: "aibrain" },
});
