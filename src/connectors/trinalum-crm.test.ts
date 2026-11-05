import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { crmView, trinalumCrm, type TrinalumDeal } from "./trinalum-crm";

it("filters by the actual Attio owner and shows Tasks separately from the mirrored next step", () => {
  const deal = { id: "deal", name: "Company", owner: "miguel-member", next_step: "Call", next_task: { id: "task", content: "Call", deadline_at: "2026-10-12T08:00:00Z" } } as TrinalumDeal;
  const members = [{ id: { workspace_member_id: "miguel-member" }, email_address: "sales@example.invalid" }, { id: { workspace_member_id: "nerea-member" }, email_address: "administration@example.invalid" }];
  expect(crmView([deal], members, "trini")).toEqual([deal]);
  expect(crmView([deal], members, "miguel")).toEqual([deal]);
  expect(crmView([deal], members, "nerea")).toEqual([]);
  expect(() => crmView([deal], [], "miguel")).toThrow("TRINALUM_OWNER_NOT_FOUND");
});

it("denies a foreign tenant before reading credentials and a foreign user before network", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "trinalum-crm-")); const file = path.join(dir, "bridge.json");
  const userId = "11111111-1111-4111-8111-111111111111";
  const fetcher = vi.fn<(socket: string, url: URL, init: RequestInit) => Promise<Response>>(async () => Response.json({ data: {} }));
  try {
    await expect(trinalumCrm("arnall", userId, { configPath: "/missing", fetcher })).rejects.toThrow("TRINALUM_ACCESS_DENIED");
    await writeFile(file, JSON.stringify({ installationId: "trinalum-production", socketPath: "/run/trinalum-broker/broker.sock", users: { [userId]: { status: "active", token: "a".repeat(64) } } }));
    await expect(trinalumCrm("trinalum-production", "22222222-2222-4222-8222-222222222222", { configPath: file, fetcher })).rejects.toThrow("TRINALUM_ACCESS_DENIED");
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockImplementation(async (_socket, _url, init) => Response.json({ data: JSON.parse(String(init.body)).operation === "attio_deals" ? { deals: [] } : { data: [] } }));
    expect(await trinalumCrm("trinalum-production", userId, { configPath: file, fetcher })).toMatchObject({ deals: [], members: [] });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(call => JSON.parse(String(call[2].body)).operation).sort()).toEqual(["attio_deals", "attio_members"]);
    fetcher.mockImplementation(async () => Response.json({ error: "ACCESS_DENIED" }, { status: 403 }));
    await expect(trinalumCrm("trinalum-production", userId, { configPath: file, fetcher })).rejects.toThrow("TRINALUM_ACCESS_DENIED");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
