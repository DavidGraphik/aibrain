import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile, stat, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { desktopMachineFromInventory, manageOutlookDesktop, parseOutlookDesktopOperatorArgs } from "../../scripts/manage-outlook-desktop";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ config: vi.fn(), workspace: vi.fn(), catalog: vi.fn() }));
vi.mock("@/config/installation", () => ({ loadInstallationConfig: mocks.config }));
vi.mock("@/admin/policy-service", () => ({ workspacePolicyForIdentity: mocks.workspace }));
vi.mock("@/catalog/access-service", () => ({ catalogRuntimeEnforcer: mocks.catalog }));
const userId = "11111111-1111-4111-8111-111111111111", email = "person@example.test";
const inventory = { schema: 1, sid: "S-1-5-21-100-200-300", computer: "PC-ONE", accounts: [{ email, accountType: 3, status: "available" }], stores: [{ storeId: "STORE-APPROVED", name: "Outlook", rootFolderId: "root" }] };
let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "outlook-cli-"))); await mkdir(path.join(root, "users", userId), { recursive: true, mode: 0o700 }); await writeFile(path.join(root, "users", userId, "user.json"), JSON.stringify({ schemaVersion: 1, userId, email, displayName: "Employee", enabled: true, workerId: "employee" }));
  mocks.config.mockResolvedValue({ installationId: "g03-production", publicUrl: "https://brain.example.test", connectors: { mail: { enabled: true, provider: "nominalia" } }, paths: { dataRoot: root, usersRoot: path.join(root, "users") } }); mocks.workspace.mockResolvedValue({ roleId: "employee", policy: { capabilities: { consult: true, execute: true } } }); mocks.catalog.mockResolvedValue({ allowsConnector: () => true, allowsConnectorWrite: () => true }); vi.stubEnv("AIBRAIN_MAIL_ENCRYPTION_KEY", Buffer.alloc(32, 9).toString("base64"));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
const flags = (root: string) => ["--action", "enroll", "--user-id", userId, "--email", email, "--inventory", path.join(root, "inventory.json"), "--store-id", "STORE-APPROVED", "--output", path.join(root, "enrollment.json")];
describe("trusted desktop pairing operator", () => {
  it("requires explicit known store IDs and the canonical inventory account; rejects ambiguous/missing/hostile flags", () => {
    expect(desktopMachineFromInventory(inventory, email, ["STORE-APPROVED"])).toMatchObject({ sid: inventory.sid, storeIds: ["STORE-APPROVED"] });
    for (const [account, ids] of [["foreign@example.test", ["STORE-APPROVED"]], [email, ["foreign"]]] as const) expect(() => desktopMachineFromInventory(inventory, account, [...ids])).toThrow();
    for (const args of [["--action", "enroll", "--user-id", userId], [...flags(root), "--command", "echo"], [...flags(root), "--email", email], ["--action", "revoke", "--user-id", "../../foreign"], [...flags(root), "--store-id", "STORE-APPROVED"]]) expect(() => parseOutlookDesktopOperatorArgs(args)).toThrow();
  });
  it("writes the secret only into an exclusive private file and never overwrites it", async () => {
    await writeFile(path.join(root, "inventory.json"), JSON.stringify(inventory)); const result = await manageOutlookDesktop(flags(root)); expect(result).not.toHaveProperty("pairingCode"); expect(JSON.stringify(result)).not.toContain("S-1");
    const file = path.join(root, "enrollment.json"), parsed = JSON.parse(await readFile(file, "utf8")); expect(parsed).toMatchObject({ schema: 1, userId, email, storeIds: ["STORE-APPROVED"] }); expect(parsed.pairingCode).toMatch(new RegExp(`^${userId}\\.`)); expect((await stat(file)).mode & 0o777).toBe(0o600);
    await expect(manageOutlookDesktop(flags(root))).rejects.toMatchObject({ code: "EEXIST" }); expect(JSON.parse(await readFile(file, "utf8")).pairingCode).toBe(parsed.pairingCode);
  });
  it("rejects symlinked inventory and nonprivate output locations before creating enrollment", async () => {
    await writeFile(path.join(root, "source.json"), JSON.stringify(inventory)); await symlink(path.join(root, "source.json"), path.join(root, "inventory.json")); await expect(manageOutlookDesktop(flags(root))).rejects.toThrow();
    await rm(path.join(root, "inventory.json")); await writeFile(path.join(root, "inventory.json"), JSON.stringify(inventory)); await mkdir(path.join(root, "public"), { mode: 0o755 }); const args = flags(root); args[args.length - 1] = path.join(root, "public", "enrollment.json"); await expect(manageOutlookDesktop(args)).rejects.toMatchObject({ code: "OUTLOOK_DESKTOP_OUTPUT_UNSAFE" });
  });
});
