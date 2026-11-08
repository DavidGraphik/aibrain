import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AlertDeliveryError,
  AlertSinkError,
  FileAlertDeliveryService,
  FileAlertSink,
  WebhookAlertSink,
  type AlertDeliveryEvent,
  type AlertSink,
} from "@/operations/alert-delivery";
import type { OperationalAlert, OperationalAlertEvaluation } from "@/operations/alerts";

const roots: string[] = [];
let clock = Date.parse("2026-08-27T12:00:00.000Z");

async function fixture(maximumPending = 1_000, maximumAttempts = 8) {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-alert-delivery-"));
  roots.push(root);
  const stateRoot = path.join(root, "state");
  return {
    root,
    stateRoot,
    service: new FileAlertDeliveryService({
      installationId: "alerts-qa",
      stateRoot,
      maximumPending,
      maximumAttempts,
      now: () => clock,
    }),
  };
}

function evaluation(alerts: readonly OperationalAlert[]): OperationalAlertEvaluation {
  return {
    schemaVersion: 1,
    status: alerts.some((alert) => alert.severity === "critical")
      ? "critical"
      : alerts.length > 0 ? "warning" : "healthy",
    evaluatedAt: new Date(clock).toISOString(),
    alerts,
  };
}

const readiness: OperationalAlert = {
  code: "READINESS_DEGRADED",
  severity: "critical",
  value: null,
  threshold: null,
};

const diskWarning: OperationalAlert = {
  code: "DISK_PRESSURE",
  severity: "warning",
  value: 0.82,
  threshold: 0.8,
};

afterEach(async () => {
  clock = Date.parse("2026-08-27T12:00:00.000Z");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FileAlertDeliveryService", () => {
  it("deduplicates transitions and delivers non-sensitive events exactly once", async () => {
    const test = await fixture();
    const raised = await test.service.reconcile(evaluation([readiness, diskWarning]));
    expect(raised.map((event) => [event.code, event.eventType])).toEqual([
      ["READINESS_DEGRADED", "raised"],
      ["DISK_PRESSURE", "raised"],
    ]);
    await expect(test.service.reconcile(evaluation([readiness, diskWarning]))).resolves.toEqual([]);

    const deliveryRoot = path.join(test.root, "delivered");
    const receipts = await test.service.dispatch(new FileAlertSink(deliveryRoot));
    expect(receipts).toHaveLength(2);
    expect(await test.service.dispatch(new FileAlertSink(deliveryRoot))).toEqual([]);
    expect(await readdir(path.join(test.stateRoot, "outbox"))).toEqual([]);
    const delivered = await Promise.all((await readdir(deliveryRoot)).map((name) =>
      readFile(path.join(deliveryRoot, name), "utf8")));
    const serialized = delivered.join("\n");
    expect(serialized).not.toMatch(/user|email|token|secret|path/iu);
  });

  it("emits ordered update and resolution generations", async () => {
    const test = await fixture();
    const [raised] = await test.service.reconcile(evaluation([diskWarning]));
    clock += 1_000;
    const [updated] = await test.service.reconcile(evaluation([{
      ...diskWarning,
      severity: "critical",
      value: 0.94,
      threshold: 0.9,
    }]));
    clock += 1_000;
    const [resolved] = await test.service.reconcile(evaluation([]));
    expect([raised?.eventType, updated?.eventType, resolved?.eventType]).toEqual([
      "raised",
      "updated",
      "resolved",
    ]);
    expect([raised?.generation, updated?.generation, resolved?.generation]).toEqual([1, 2, 3]);
    expect(resolved).toMatchObject({ severity: "critical", value: 0.94, threshold: 0.9 });
  });

  it("persists sanitized failure state and retries with backoff", async () => {
    const test = await fixture();
    const [event] = await test.service.reconcile(evaluation([readiness]));
    let attempts = 0;
    const sink: AlertSink = {
      id: "test-sink",
      async deliver() {
        attempts += 1;
        if (attempts === 1) {
          throw new AlertSinkError("unavailable", "private upstream detail must not persist");
        }
        return { receiptId: "retry-receipt" };
      },
    };
    await expect(test.service.dispatch(sink)).resolves.toEqual([]);
    const jobPath = path.join(test.stateRoot, "outbox", `${event?.eventId}.json`);
    const failed = await readFile(jobPath, "utf8");
    expect(JSON.parse(failed)).toMatchObject({ attempts: 1, lastFailure: "unavailable" });
    expect(failed).not.toContain("private upstream detail");
    await expect(test.service.dispatch(sink)).resolves.toEqual([]);
    expect(attempts).toBe(1);
    clock += 1_000;
    await expect(test.service.dispatch(sink)).resolves.toHaveLength(1);
    expect(attempts).toBe(2);
  });

  it("stops retrying at the durable attempt bound and reports exhausted work", async () => {
    const test = await fixture(1_000, 2);
    await test.service.reconcile(evaluation([readiness]));
    let attempts = 0;
    const sink: AlertSink = {
      id: "bounded-sink",
      async deliver() {
        attempts += 1;
        throw new AlertSinkError("unavailable", "synthetic outage");
      },
    };
    await test.service.dispatch(sink);
    clock += 1_000;
    await test.service.dispatch(sink);
    clock += 60_000;
    await expect(test.service.dispatch(sink)).resolves.toEqual([]);
    expect(attempts).toBe(2);
    await expect(test.service.status()).resolves.toMatchObject({
      pending: 0,
      retryable: 0,
      deferred: 0,
      exhausted: 1,
      lastFailureCounts: { unavailable: 1 },
    });
    expect(await readdir(path.join(test.stateRoot, "outbox"))).toEqual([]);
    expect(await readdir(path.join(test.stateRoot, "failed"))).toHaveLength(1);
  });

  it("does not retry a permanent webhook rejection", async () => {
    const test = await fixture(1_000, 8);
    await test.service.reconcile(evaluation([readiness]));
    let attempts = 0;
    const sink: AlertSink = {
      id: "rejected-sink",
      async deliver() {
        attempts += 1;
        throw new AlertSinkError("rejected", "synthetic rejection");
      },
    };
    await test.service.dispatch(sink);
    clock += 60_000;
    await test.service.dispatch(sink);
    expect(attempts).toBe(1);
    await expect(test.service.status()).resolves.toMatchObject({ pending: 0, exhausted: 1 });
  });

  it("fails before partial reconciliation when the outbox is saturated", async () => {
    const test = await fixture(1);
    await expect(test.service.reconcile(evaluation([readiness, diskWarning]))).rejects.toMatchObject({
      code: "ALERT_DELIVERY_BACKPRESSURE",
    });
    await expect(readdir(path.join(test.stateRoot, "outbox"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(path.join(test.stateRoot, "state"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses an existing receipt to recover a crash before outbox cleanup", async () => {
    const test = await fixture();
    const [event] = await test.service.reconcile(evaluation([readiness]));
    const receiptRoot = path.join(test.stateRoot, "receipts");
    await writeFile(path.join(test.root, "placeholder"), "unused");
    const sink = new FileAlertSink(path.join(test.root, "sink"));
    await test.service.dispatch(sink);
    const receiptName = `${event?.eventId}.json`;
    const receipt = await readFile(path.join(receiptRoot, receiptName), "utf8");
    await writeFile(path.join(test.stateRoot, "outbox", receiptName), JSON.stringify({ invalid: true }));
    let deliveries = 0;
    const recovered = await test.service.dispatch({
      id: "must-not-run",
      async deliver() {
        deliveries += 1;
        return { receiptId: "unexpected" };
      },
    });
    expect(recovered).toEqual([JSON.parse(receipt)]);
    expect(deliveries).toBe(0);
    expect(await readdir(path.join(test.stateRoot, "outbox"))).toEqual([]);
  });
});

describe("WebhookAlertSink", () => {
  it("uses HTTPS, an idempotency key and no fields beyond the typed event", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const fetchImplementation: typeof fetch = async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response(null, { status: 202, headers: { "x-request-id": "remote-123" } });
    };
    const sink = new WebhookAlertSink({
      endpoint: "https://alerts.example.test/v1/aibrain",
      bearerToken: "synthetic-token",
      fetchImplementation,
    });
    const event: AlertDeliveryEvent = {
      schemaVersion: 1,
      eventId: "a".repeat(64),
      installationId: "alerts-qa",
      code: "READINESS_DEGRADED",
      eventType: "raised",
      severity: "critical",
      value: null,
      threshold: null,
      generation: 1,
      evaluatedAt: "2026-08-27T12:00:00.000Z",
      createdAt: "2026-08-27T12:00:00.000Z",
    };
    await expect(sink.deliver(event)).resolves.toEqual({ receiptId: "remote-123" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("https://alerts.example.test/v1/aibrain");
    expect(new Headers(calls[0]?.init?.headers).get("Idempotency-Key")).toBe(event.eventId);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(event);
    expect(() => new WebhookAlertSink({ endpoint: "http://alerts.example.test" })).toThrow(AlertDeliveryError);
  });

  it.each([
    [429, "unavailable"],
    [503, "unavailable"],
    [400, "rejected"],
  ] as const)("classifies HTTP %i without exposing the remote response", async (status, code) => {
    const sink = new WebhookAlertSink({
      endpoint: "https://alerts.example.test/v1/aibrain",
      fetchImplementation: async () => new Response("sensitive remote body", { status }),
    });
    await expect(sink.deliver({
      schemaVersion: 1,
      eventId: "b".repeat(64),
      installationId: "alerts-qa",
      code: "EGRESS_GATEWAY_DEGRADED",
      eventType: "raised",
      severity: "critical",
      value: null,
      threshold: null,
      generation: 1,
      evaluatedAt: "2026-08-27T12:00:00.000Z",
      createdAt: "2026-08-27T12:00:00.000Z",
    })).rejects.toMatchObject({ code, message: "Alert webhook rejected the delivery." });
  });

  it("classifies a timeout as retryable delivery failure", async () => {
    const sink = new WebhookAlertSink({
      endpoint: "https://alerts.example.test/v1/aibrain",
      fetchImplementation: async () => { throw new DOMException("timed out", "TimeoutError"); },
    });
    await expect(sink.deliver({
      schemaVersion: 1,
      eventId: "c".repeat(64),
      installationId: "alerts-qa",
      code: "REPLICA_UNVERIFIED",
      eventType: "raised",
      severity: "critical",
      value: null,
      threshold: null,
      generation: 1,
      evaluatedAt: "2026-08-27T12:00:00.000Z",
      createdAt: "2026-08-27T12:00:00.000Z",
    })).rejects.toMatchObject({ code: "timeout" });
  });
});
