// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const navigation = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation }));
import { SupportLoginForm } from "./support-login-form";
beforeEach(() => { navigation.push.mockReset(); navigation.refresh.mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("private support code file login", () => {
  it("keeps uploaded code masked, waits for explicit submit, then uses normal server login", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal("fetch", fetcher);
    render(<SupportLoginForm />);
    const code = "a".repeat(43); const file = new File([code], "support-code.txt", { type: "text/plain" });
    Object.defineProperty(file, "text", { value: async () => code });
    fireEvent.change(screen.getByLabelText("Fitxer privat del codi"), { target: { files: [file] } });
    const input = screen.getByLabelText("Codi de suport d’un sol ús");
    await waitFor(() => expect(input).toHaveValue(code));
    expect(input).toHaveAttribute("type", "password"); expect(screen.queryByText(code)).toBeNull(); expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Iniciar comprovació" }));
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/"));
    expect(fetcher).toHaveBeenCalledWith("/api/auth/support", expect.objectContaining({ method: "POST", body: JSON.stringify({ code }) }));
    expect(input).toHaveValue(""); expect(navigation.refresh).toHaveBeenCalledOnce();
  });
  it("rejects oversized files without reading or sending their contents", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher); render(<SupportLoginForm />);
    const file = new File(["x".repeat(129)], "large.txt"); const text = vi.fn(); Object.defineProperty(file, "text", { value: text });
    fireEvent.change(screen.getByLabelText("Fitxer privat del codi"), { target: { files: [file] } });
    expect(screen.getByRole("alert")).toHaveTextContent("El fitxer del codi no és vàlid."); expect(text).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
});
