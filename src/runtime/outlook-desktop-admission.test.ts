import { afterEach, expect, it, vi } from "vitest";
import type { AuthSession } from "@/auth/types";
import type { InstallationConfig } from "@/config/installation-schema";
vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/connectors/outlook-desktop-service", () => ({ readOutlookDesktopStatusForIdentity: state.read }));
import { desktopOutlookAvailableForTurn } from "./outlook-desktop-admission";
const config = { installationId: "g03-production", connectors: { mail: { enabled: true, provider: "nominalia" } } } as InstallationConfig;
const session = (): AuthSession => ({ provider: "local", tenant: { id: "g03-production", name: "G03" },
  user: { id: "10000000-0000-4000-8000-000000000002", email: "employee@example.invalid", name: "Employee", avatarUrl: null }, expiresAt: new Date(Date.now() + 60000).toISOString() });
afterEach(() => state.read.mockReset());
it.each(["ready", "offline", "outlook_closed"])("admits only the exact paired employee, including archive status %s", async status => {
  const target = session(); state.read.mockResolvedValue({ connected: true, status, accountEmail: target.user.email });
  expect(await desktopOutlookAvailableForTurn(config, target)).toBe(true);
  expect(state.read).toHaveBeenCalledWith({ config, userId: target.user.id });
});
it("installation enablement does not invent a paired desktop or block server mail when status fails", async () => {
  state.read.mockResolvedValue({ connected: false, status: "not_paired" });
  expect(await desktopOutlookAvailableForTurn(config, session())).toBe(false);
  state.read.mockRejectedValue(Error("Local desktop unavailable"));
  expect(await desktopOutlookAvailableForTurn(config, session())).toBe(false);
});
it("rejects another employee mailbox and foreign or expired session", async () => {
  state.read.mockResolvedValue({ connected: true, status: "ready", accountEmail: "another@example.invalid" });
  expect(await desktopOutlookAvailableForTurn(config, session())).toBe(false);
  state.read.mockClear();const target = session();target.tenant.id = "another-tenant";
  expect(await desktopOutlookAvailableForTurn(config, target)).toBe(false);
  target.tenant.id = "g03-production";target.expiresAt = new Date(Date.now() - 1).toISOString();
  expect(await desktopOutlookAvailableForTurn(config, target)).toBe(false);expect(state.read).not.toHaveBeenCalled();
});
