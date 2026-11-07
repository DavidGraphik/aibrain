// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecoveryForm } from "@/components/recovery-form";

const navigation = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation }));
vi.mock("@/i18n/provider", () => ({ useUiText: () => (text: string) => text }));
vi.mock("@/components/ui/primitives", () => ({ BrandMark: () => null, ThemeToggle: () => null }));
const branding = {
  installationId: "example-lab", companyName: "Example", companySlug: "example",
  publicUrl: "https://example.test", productName: "Brain", logoPath: "/logo.svg",
  faviconPath: "/favicon.svg", accentColor: "#315ee7",
};

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function enterPassword() {
  fireEvent.change(screen.getByLabelText("Contraseña nueva"), { target: { value: "Recovered-pass-123" } });
  fireEvent.change(screen.getByLabelText("Repite la contraseña"), { target: { value: "Recovered-pass-123" } });
  fireEvent.click(screen.getByRole("button", { name: "Actualizar y entrar" }));
}

describe("password recovery form", () => {
  it("scrubs the link while retaining routing state and does not consume proof on page load", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ authenticated: true })));
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({ syntheticRouterState: true }, "", "/auth/recovery?token_hash=synthetic-hash&type=recovery");
    render(<RecoveryForm branding={branding} proof={{ tokenHash: "synthetic-hash" }} />);
    expect(window.location.search).toBe("");
    expect(window.history.state).toEqual({ syntheticRouterState: true });
    expect(fetchMock).not.toHaveBeenCalled();
    enterPassword();
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/"));
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/auth/password/recovery");
    expect(JSON.parse(String(request.body))).toEqual({ tokenHash: "synthetic-hash", password: "Recovered-pass-123", confirmation: "Recovered-pass-123" });
  });

  it("shows expired or reused proof without navigating into the workbench", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 410 })));
    render(<RecoveryForm branding={branding} proof={{ tokenHash: "synthetic-hash" }} />);
    enterPassword();
    expect(await screen.findByRole("alert")).toHaveTextContent("El enlace de recuperación no es válido, ya se ha usado o ha caducado. Solicita otro enlace.");
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("rejects unsupported implicit sessions and removes their fragment without storing or exchanging them", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/auth/recovery#access_token=synthetic-access&refresh_token=synthetic-refresh&type=recovery");
    render(<RecoveryForm branding={branding} proof={null} />);
    expect(screen.getByRole("alert")).toHaveTextContent("El enlace de recuperación no es válido o ha caducado.");
    expect(screen.queryByLabelText("Contraseña nueva")).toBeNull();
    expect(window.location.hash).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });
});
