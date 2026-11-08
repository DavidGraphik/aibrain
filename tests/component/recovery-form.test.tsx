// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "../render-spanish";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecoveryForm } from "@/components/recovery-form";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/components/ui/primitives", () => ({ BrandMark: () => null, ThemeToggle: () => null }));

const branding = {
  installationId: "test", companyName: "Test", companySlug: "test",
  publicUrl: "https://example.test", productName: "Test AI",
  logoPath: "/logo.svg", faviconPath: "/favicon.svg", accentColor: "#315ee7",
};

function setup(password = "PrivatePassword123", confirmation = password) {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ authenticated: true }));
  vi.stubGlobal("fetch", fetcher);
  const view = render(<RecoveryForm branding={branding} proof={{ tokenHash: "synthetic-proof" }} />);
  fireEvent.change(screen.getByLabelText("Contraseña nueva"), { target: { value: password } });
  fireEvent.change(screen.getByLabelText("Repite la contraseña"), { target: { value: confirmation } });
  return { fetcher, form: view.container.querySelector("form")! };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("password recovery", () => {
  it("reveals both passwords on request without submitting or losing their values", () => {
    const { fetcher } = setup();
    const fields = [screen.getByLabelText("Contraseña nueva"), screen.getByLabelText("Repite la contraseña")];
    fields.forEach((field) => expect(field).toHaveAttribute("type", "password"));
    fireEvent.click(screen.getByRole("button", { name: "Mostrar contraseñas" }));
    fields.forEach((field) => { expect(field).toHaveAttribute("type", "text"); expect(field).toHaveValue("PrivatePassword123"); });
    expect(screen.getByRole("button", { name: "Ocultar contraseñas" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Ocultar contraseñas" }));
    fields.forEach((field) => expect(field).toHaveAttribute("type", "password"));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["OnlyLettersPassword", "123456789012345", "Short1"])("explains the full policy without consuming a token for %s", (password) => {
    const { fetcher, form } = setup(password);
    fireEvent.submit(form);
    expect(screen.getByRole("alert")).toHaveTextContent("con al menos una letra y un número");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("allows correcting locally rejected input before consuming the proof", async () => {
    const { fetcher, form } = setup("OnlyLettersPassword");
    fireEvent.submit(form);
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Contraseña nueva"), { target: { value: "PrivatePassword123" } });
    fireEvent.change(screen.getByLabelText("Repite la contraseña"), { target: { value: "PrivatePassword123" } });
    fireEvent.submit(form);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("identifies mismatched fields before contacting the provider", () => {
    const { fetcher, form } = setup("PrivatePassword123", "PrivatePassword124");
    fireEvent.submit(form);
    expect(screen.getByRole("alert")).toHaveTextContent("Las contraseñas no coinciden");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([[401, "Solicita otro enlace"], [410, "Solicita otro enlace"], [429, "Demasiados intentos"], [503, "No hemos podido confirmar el cambio"]])("explains a %s response", async (status, message) => {
    const { fetcher, form } = setup();
    fetcher.mockResolvedValue(new Response("{}", { status: Number(status) }));
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(String(message)));
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("sends a valid matching password and navigates only after success", async () => {
    const { fetcher, form } = setup();
    fireEvent.submit(form);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(fetcher).toHaveBeenCalledWith("/api/auth/password/recovery", expect.objectContaining({
      method: "POST", body: JSON.stringify({ tokenHash: "synthetic-proof", password: "PrivatePassword123", confirmation: "PrivatePassword123" }),
    }));
  });
});

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
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/auth/password/recovery");
    expect(JSON.parse(String(request.body))).toEqual({ tokenHash: "synthetic-hash", password: "Recovered-pass-123", confirmation: "Recovered-pass-123" });
  });

  it("shows expired or reused proof without navigating into the workbench", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 410 })));
    render(<RecoveryForm branding={branding} proof={{ tokenHash: "synthetic-hash" }} />);
    enterPassword();
    expect(await screen.findByRole("alert")).toHaveTextContent("El enlace de recuperación no es válido, ya se ha usado o ha caducado. Solicita otro enlace.");
    expect(router.replace).not.toHaveBeenCalled();
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
  it("stops resubmission after a consumed-proof password rejection and offers a fresh link", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ code: "recovery_password_rejected", nextStep: "new_link", error: "UNSAFE_PROVIDER_DETAIL" }, { status: 422 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<RecoveryForm branding={branding} proof={{ code: "synthetic-code" }} />);
    enterPassword();
    expect(await screen.findByRole("link", { name: "Solicitar otro enlace" })).toHaveAttribute("href", "/login");
    expect(screen.queryByLabelText("Contraseña nueva")).toBeNull();
    expect(screen.queryByText("UNSAFE_PROVIDER_DETAIL")).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce(); expect(router.replace).not.toHaveBeenCalled();
  });

  it("keeps local pre-consumption validation retryable", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ code: "recovery_invalid_input", nextStep: "retry" }, { status: 400 })).mockResolvedValueOnce(Response.json({ authenticated: true }));
    vi.stubGlobal("fetch", fetchMock);
    render(<RecoveryForm branding={branding} proof={{ code: "synthetic-code" }} />);
    enterPassword(); await screen.findByRole("alert");
    expect(screen.getByLabelText("Contraseña nueva")).toHaveValue("Recovered-pass-123");
    fireEvent.click(screen.getByRole("button", { name: "Actualizar y entrar" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("distinguishes an updated password from an unavailable local session", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ code: "recovery_session_unavailable", nextStep: "sign_in" }, { status: 503 })));
    render(<RecoveryForm branding={branding} proof={{ code: "synthetic-code" }} />);
    enterPassword(); expect(await screen.findByRole("alert")).toHaveTextContent("La contraseña se ha actualizado");
    expect(screen.getByRole("link", { name: "Volver al acceso" })).toHaveAttribute("href", "/login");
    expect(screen.queryByLabelText("Contraseña nueva")).toBeNull();
  });
  it.each(["transport", "malformed-success", "unknown-http"])("does not retry or authenticate an unconfirmed %s outcome", async mode => {
    const fetchMock = mode === "transport" ? vi.fn().mockRejectedValue(Error("UNSAFE_TRANSPORT_DETAILS"))
      : vi.fn().mockResolvedValue(Response.json({}, { status: mode === "unknown-http" ? 503 : 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<RecoveryForm branding={branding} proof={{ code: "synthetic-code" }} />);
    enterPassword(); expect(await screen.findByRole("alert")).toHaveTextContent("No hemos podido confirmar el cambio");
    expect(screen.queryByLabelText("Contraseña nueva")).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce(); expect(router.replace).not.toHaveBeenCalled();
  });
  it("coalesces duplicate submissions before a network response", async () => {
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })); vi.stubGlobal("fetch", fetchMock);
    render(<RecoveryForm branding={branding} proof={{ code: "synthetic-code" }} />);
    const form = screen.getByRole("button", { name: "Actualizar y entrar" }).closest("form")!;
    enterPassword(); fireEvent.submit(form); fireEvent.submit(form);
    expect(fetchMock).toHaveBeenCalledOnce();
    await act(async () => finish(Response.json({ authenticated: true })));
    expect(router.replace).toHaveBeenCalledOnce();
  });

});
