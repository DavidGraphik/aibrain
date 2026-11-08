vi.mock("server-only", () => ({}));
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ readUser: vi.fn(), readInstallation: vi.fn() }));
vi.mock("@/config/installation", () => ({ loadInstallationConfig: async () => ({ installationId: "g03-production", paths: { dataRoot: "/private/g03" } }) }));
vi.mock("./user-language-store", () => ({ FileUserLanguageStore: class { read = mocks.readUser; } }));
vi.mock("./installation-language-store", () => ({ FileInstallationLanguageStore: class { read = mocks.readInstallation; } }));
import type { AuthSession } from "@/auth/types";
import { installationUiLocale, userUiLocale } from "./server";
const session = (tenantId = "g03-production") => ({ tenant: { id: tenantId }, user: { id: "rafa" } }) as AuthSession;
beforeEach(() => { mocks.readUser.mockReset().mockResolvedValue(null); mocks.readInstallation.mockReset().mockResolvedValue("ca"); });
describe("authenticated interface locale", () => {
  it("uses a personal choice and leaves the installation default untouched", async () => {
    mocks.readUser.mockResolvedValue("es");
    expect(await userUiLocale(session())).toBe("es");
    expect(mocks.readUser).toHaveBeenCalledWith("rafa");
    expect(mocks.readInstallation).not.toHaveBeenCalled();
    expect(await installationUiLocale()).toBe("ca");
  });
  it("falls back for unset, anonymous or foreign users without reading foreign preferences", async () => {
    expect(await userUiLocale(session())).toBe("ca");
    mocks.readUser.mockClear();
    expect(await userUiLocale(null)).toBe("ca");
    expect(await userUiLocale(session("foreign"))).toBe("ca");
    expect(mocks.readUser).not.toHaveBeenCalled();
  });
});
