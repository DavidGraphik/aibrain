import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createOperationalLogger,
  jsonLineOperationalLogSink,
  runWorkerReplaySoak,
} from "@/operations";

const HELP = `Usage: npm run test:soak -- [options]

Options:
  --duration-ms <ms>       Target duration, default 120000
  --cycles <count>         Optional deterministic cycle limit
  --concurrency <count>    Concurrent isolated workers, default 4
  --restart-every <count>  Restart/replay cadence in cycles, default 20
  --sample-ms <ms>         Resource sampling interval, default 1000
  --cycle-delay-ms <ms>    Pause between cycles, default 25
  --request-timeout-ms <ms> Per-request timeout, default 10000
  --work-root <absolute>   Parent for isolated run data; auto temp by default
  --qa                     Eight-hour, twenty-worker QA profile
  --help                    Show this help
`;

type Parsed = {
  durationMs?: number;
  maxCycles?: number;
  concurrency?: number;
  restartEveryCycles?: number;
  sampleIntervalMs?: number;
  cycleDelayMs?: number;
  requestTimeoutMs?: number;
  workRoot?: string;
  qa: boolean;
};

function numeric(value: string | undefined, option: string) {
  if (value === undefined || !/^\d+$/u.test(value)) throw new Error(`${option} requires a non-negative integer.`);
  return Number(value);
}

function parseArguments(argv: readonly string[]): Parsed {
  const parsed: Parsed = { qa: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      process.stdout.write(HELP);
      process.exit(0);
    }
    if (argument === "--qa") {
      parsed.qa = true;
      continue;
    }
    const value = argv[++index];
    if (argument === "--duration-ms") parsed.durationMs = numeric(value, argument);
    else if (argument === "--cycles") parsed.maxCycles = numeric(value, argument);
    else if (argument === "--concurrency") parsed.concurrency = numeric(value, argument);
    else if (argument === "--restart-every") parsed.restartEveryCycles = numeric(value, argument);
    else if (argument === "--sample-ms") parsed.sampleIntervalMs = numeric(value, argument);
    else if (argument === "--cycle-delay-ms") parsed.cycleDelayMs = numeric(value, argument);
    else if (argument === "--request-timeout-ms") parsed.requestTimeoutMs = numeric(value, argument);
    else if (argument === "--work-root") {
      if (!value) throw new Error("--work-root requires an absolute path.");
      parsed.workRoot = value;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return parsed;
}

const logger = createOperationalLogger({
  sink: jsonLineOperationalLogSink(process.stderr),
  baseAttributes: { command: "aibrain-soak" },
});

async function main() {
  let automaticRoot: string | null = null;
  try {
    const parsed = parseArguments(process.argv.slice(2));
    if (parsed.workRoot && !path.isAbsolute(parsed.workRoot)) {
      throw new Error("--work-root must be absolute.");
    }
    const workRoot = parsed.workRoot
      ? parsed.workRoot
      : (automaticRoot = await mkdtemp(path.join(tmpdir(), "aibrain-soak-")));
    const report = await runWorkerReplaySoak({
      workRoot,
      durationMs: parsed.durationMs ?? (parsed.qa ? 8 * 60 * 60 * 1_000 : undefined),
      maxCycles: parsed.maxCycles,
      concurrency: parsed.concurrency ?? (parsed.qa ? 20 : undefined),
      restartEveryCycles: parsed.restartEveryCycles ?? (parsed.qa ? 100 : undefined),
      sampleIntervalMs: parsed.sampleIntervalMs ?? (parsed.qa ? 30_000 : undefined),
      cycleDelayMs: parsed.cycleDelayMs ?? (parsed.qa ? 100 : undefined),
      requestTimeoutMs: parsed.requestTimeoutMs,
      logger,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status !== "pass") process.exitCode = 1;
  } catch (error) {
    logger.error("soak.failed", { error });
    process.exitCode = 1;
  } finally {
    if (automaticRoot) await rm(automaticRoot, { recursive: true, force: true });
  }
}

void main();
