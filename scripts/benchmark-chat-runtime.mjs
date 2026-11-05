import { performance } from "node:perf_hooks";

const iterations = Number.parseInt(process.env.AIBRAIN_BENCH_ITERATIONS ?? "80", 10);
const transportIterations = Number.parseInt(process.env.AIBRAIN_BENCH_TRANSPORT_ITERATIONS ?? "800", 10);
const encoder = new TextEncoder();

function percentile(samples, ratio) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

function summary(samples) {
  return {
    p50Ms: Number(percentile(samples, 0.5).toFixed(3)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(3)),
  };
}

function io(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function legacyAdmission() {
  await io(8); // memory
  await io(12); // worker readiness
  await io(7); // web capability discovery
  await io(6); // catalog skill synchronization with no selected skill
}

async function optimizedAdmission() {
  await Promise.all([io(8), io(12)]); // memory + worker readiness
  await io(6); // policy-enforcing skill synchronization remains fail-closed
  // Web is a server invariant, so capability discovery is not on admission.
}

async function measure(operation, count) {
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const startedAt = performance.now();
    await operation();
    samples.push(performance.now() - startedAt);
  }
  return summary(samples);
}

async function measureBusyWorkerAdmission(serialized, count) {
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const outputPersistence = io(20);
    const startedAt = performance.now();
    if (serialized) await outputPersistence;
    else await Promise.resolve();
    samples.push(performance.now() - startedAt);
    await outputPersistence;
  }
  return summary(samples);
}

const events = [
  { type: "activity", item: { id: "runtime", label: "Conectado", status: "complete" } },
  { type: "delta", value: "Hola" },
  { type: "delta", value: ", mundo" },
  { type: "done" },
];

function directAppServerDelivery() {
  let meaningful = false;
  for (const event of events) meaningful ||= event.type === "delta";
  if (!meaningful) throw new Error("Direct fixture did not deliver a meaningful event.");
}

function apiNdjsonDelivery() {
  const bytes = encoder.encode(events.map((event) => `${JSON.stringify(event)}\n`).join(""));
  const text = new TextDecoder().decode(bytes);
  let meaningful = false;
  for (const record of text.split("\n")) {
    if (!record) continue;
    meaningful ||= JSON.parse(record).type === "delta";
  }
  if (!meaningful) throw new Error("NDJSON fixture did not deliver a meaningful event.");
}

function measureSync(operation, count) {
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const startedAt = performance.now();
    operation();
    samples.push(performance.now() - startedAt);
  }
  return summary(samples);
}

const report = {
  schemaVersion: 1,
  scope: "local-controlled-runtime-overhead",
  excludes: ["provider", "network", "model-generation", "filesystem-persistence"],
  admission: {
    fixtureMs: { memory: 8, worker: 12, capabilityDiscovery: 7, unselectedSkillSync: 6 },
    before: await measure(legacyAdmission, iterations),
    after: await measure(optimizedAdmission, iterations),
  },
  sameUserBusyWorkerAdmission: {
    fixtureOutputPersistenceMs: 20,
    beforeSharedDirectionChain: await measureBusyWorkerAdmission(true, iterations),
    afterIndependentDirectionLanes: await measureBusyWorkerAdmission(false, iterations),
  },
  delivery: {
    directAppServer: measureSync(directAppServerDelivery, transportIterations),
    apiNdjson: measureSync(apiNdjsonDelivery, transportIterations),
  },
};

console.log(JSON.stringify(report, null, 2));
