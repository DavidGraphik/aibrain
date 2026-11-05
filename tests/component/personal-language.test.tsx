// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "../render-spanish";
import { PersonalLanguage } from "@/components/personal-language";
import { UiLocaleProvider } from "@/i18n/provider";
const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
beforeEach(() => mocks.refresh.mockReset());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("personal interface language", () => {
  it("saves just the chosen locale and refreshes the authenticated interface", async () => {
    const fetchMock = vi.fn(async () => Response.json({ locale: "es" })); vi.stubGlobal("fetch", fetchMock);
    render(<UiLocaleProvider locale="ca"><PersonalLanguage /></UiLocaleProvider>);
    fireEvent.change(screen.getByLabelText("El teu idioma"), { target: { value: "es" } });
    expect(fetchMock).toHaveBeenCalledWith("/api/settings/language", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ locale: "es" }) });
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
  });
  it("keeps the prior language and shows a retryable error if saving fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "private diagnostic" }, { status: 503 })));
    render(<PersonalLanguage />);
    fireEvent.change(screen.getByLabelText("Tu idioma"), { target: { value: "en" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("No se ha podido guardar el idioma");
    expect(screen.getByLabelText("Tu idioma")).toHaveValue("es");
    expect(document.body.textContent).not.toContain("private diagnostic");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
