import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { trinalumConnectorHealth } from "./trinalum-capabilities";
vi.mock("server-only", () => ({}));
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function config() {
  const dir = await mkdtemp(path.join(tmpdir(), "trinalum-health-")); dirs.push(dir);
  const file = path.join(dir, "bridge.json");
  await writeFile(file, JSON.stringify({ installationId: "trinalum-production", socketPath: "/run/trinalum-broker/broker.sock", users: { david: { status: "active", token: "a".repeat(64) } } }));
  return file;
}
it("uses the current binding and never claims an unconnected own mailbox works", async () => {
  const fetcher = vi.fn(async () => Response.json({ installationId: "trinalum-production", userId: "david", operations: ["attio_tasks", "sibema_read"], mailbox: null }));
  const health = await trinalumConnectorHealth("trinalum-production", "david", { configPath: await config(), fetcher });
  expect(health.get("trinalum-attio")?.status).toBe("connected");
  expect(health.get("trinalum-sibema")?.status).toBe("connected");
  expect(health.get("trinalum-mail")?.status).toBe("not_configured");
});
it("does not reuse another actor or installation and fails closed after transport failure", async () => {
  const fetcher = vi.fn(async () => Response.json({ installationId: "trinalum-production", userId: "foreign", operations: ["attio_tasks"], mailbox: null }));
  const configPath = await config();
  expect((await trinalumConnectorHealth("arnall", "david", { configPath, fetcher })).get("trinalum-attio")?.status).toBe("not_configured");
  expect(fetcher).not.toHaveBeenCalled();
  expect((await trinalumConnectorHealth("trinalum-production", "foreign", { configPath, fetcher })).get("trinalum-attio")?.status).toBe("not_configured");
  expect(fetcher).not.toHaveBeenCalled();
  expect((await trinalumConnectorHealth("trinalum-production", "david", { configPath, fetcher })).get("trinalum-attio")?.status).toBe("degraded");
});
it("captures one bound inventory per resolution, with no reuse after revocation or an invalid response", async () => {
  const configPath = await config(), capture = vi.fn();
  const fetcher = vi.fn(async () => Response.json({ installationId: "trinalum-production", userId: "david", operations: ["attio_search"], mailbox: null }));
  await trinalumConnectorHealth("trinalum-production", "david", { configPath, fetcher, onCapabilities: capture });
  expect(fetcher).toHaveBeenCalledTimes(1); expect(capture).toHaveBeenCalledTimes(1);
  expect(capture.mock.calls[0][0]).toMatchObject({ installationId: "trinalum-production", userId: "david", operations: ["attio_search"], bindingFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
  fetcher.mockImplementation(async () => Response.json({ installationId: "trinalum-production", userId: "david", operations: [], mailbox: null }));
  await trinalumConnectorHealth("trinalum-production", "david", { configPath, fetcher, onCapabilities: capture });
  expect(capture.mock.calls[1][0].operations).toEqual([]);
  for (const operations of [["attio_search", "attio_search"], [null], "attio_search"]) {
    capture.mockClear(); fetcher.mockImplementation(async () => Response.json({ installationId: "trinalum-production", userId: "david", operations, mailbox: null }));
    await trinalumConnectorHealth("trinalum-production", "david", { configPath, fetcher, onCapabilities: capture });
    expect(capture).not.toHaveBeenCalled();
  }
  capture.mockClear(); fetcher.mockImplementation(async () => Response.json({ installationId: "trinalum-production", userId: "foreign", operations: ["attio_search"] }));
  await trinalumConnectorHealth("trinalum-production", "david", { configPath, fetcher, onCapabilities: capture });
  expect(capture).not.toHaveBeenCalled();
});
