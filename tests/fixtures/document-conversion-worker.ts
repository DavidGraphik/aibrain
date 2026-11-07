import { setTimeout as delay } from "node:timers/promises";
import { FileDocumentConversionGate } from "../../src/documents/conversion-gate";

const [rootDirectory, userId, mode, holdValue, maximumValue] = process.argv.slice(2);
if (!rootDirectory || !userId || !mode) {
  process.stderr.write("document-conversion-worker requires root, user, mode, hold and maximum\n");
  process.exit(64);
}

const holdMs = Number(holdValue ?? "0");
const maxConcurrent = Number(maximumValue ?? "1");
const gate = new FileDocumentConversionGate({
  rootDirectory,
  maxConcurrent,
  retryAfterMs: 250,
  staleAfterMs: 120,
  heartbeatIntervalMs: 25,
});

function event(name: string, extra: Record<string, unknown> = {}) {
  process.stdout.write(`${JSON.stringify({ event: name, userId, processId: process.pid, ...extra })}\n`);
}

async function main() {
  try {
    await gate.run(async () => {
      event("acquired");
      if (mode === "crash") {
        await new Promise(() => { setInterval(() => undefined, 1_000); });
      }
      await delay(holdMs);
      event("leaving");
    });
    event("released");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "UNKNOWN";
    event("failed", { code });
    process.exitCode = 1;
  }
}

void main();
