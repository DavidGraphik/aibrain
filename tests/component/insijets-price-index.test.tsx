// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "../render-spanish";
import { afterEach, expect, it, vi } from "vitest";
import { InsiJetsCMSPanel } from "@/components/insijets-cms-panel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("uses the paired CMS for route and price selection in six languages without exposing unrelated records", async () => {
  const records = ["en", "it", "es", "fr", "de", "ar"].flatMap(locale => [
    { id: "route-one", type: "route", locale, title: `DEMO route ${locale}`, status: "draft", revision: 1 },
    { id: "price-one", type: "price", locale, title: `DEMO price ${locale}`, status: "draft", revision: 7 },
    { id: "aircraft-one", type: "aircraft", locale, title: `DEMO aircraft ${locale}`, status: "draft", revision: 1 },
  ]);
  const fetchMock = vi.fn(async (url: string) => Response.json(url.endsWith("session") ? { user: { email: "operator@example.invalid" } } : { records }));
  vi.stubGlobal("fetch", fetchMock);
  render(<InsiJetsCMSPanel mode="pricing" onToggleSidebar={() => {}} />);
  await screen.findByRole("button", { name: /DEMO route en/ });
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Índice de precios");
  expect(screen.queryByRole("button", { name: /DEMO aircraft/ })).toBeNull();
  // The comparison view stays lightweight until the user chooses a source to edit.
  expect(screen.queryByTitle("InsiJets Price Index editor")).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Familia de contenido" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Idioma" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "DEMO route en" }));
  fireEvent.click(screen.getByRole("button", { name: "Editar fuente" }));
  expect(screen.getByRole("button", { name: /DEMO route en/ })).toHaveAttribute("aria-pressed", "true");
  fireEvent.change(screen.getByRole("combobox", { name: "Familia de contenido" }), { target: { value: "price" } });
  expect(screen.getByRole("button", { name: /DEMO price en/ })).toHaveTextContent("Prices · draft · r7");
  fireEvent.click(screen.getByRole("button", { name: /DEMO price en/ }));
  for (const locale of ["it", "es", "fr", "de", "ar"]) {
    fireEvent.change(screen.getByRole("combobox", { name: "Idioma" }), { target: { value: locale } });
    await waitFor(() => expect(screen.getByRole("button", { name: new RegExp(`DEMO price ${locale}`) })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByRole("button", { name: new RegExp(`DEMO price ${locale}`) })).toHaveTextContent("Prices · draft · r7");
    expect(screen.queryByRole("button", { name: /DEMO aircraft/ })).toBeNull();
  }
  expect(screen.getByTitle("InsiJets Price Index editor")).toHaveAttribute("src", "/api/insijets/cms/admin");
  expect(fetchMock.mock.calls.every(([url]) => url.startsWith("/api/insijets/cms/"))).toBe(true);
});

it.each([403, 503])("keeps a denied or unavailable CMS connection closed (%s)", async status => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status })));
  render(<InsiJetsCMSPanel mode="pricing" onToggleSidebar={() => {}} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Datos fuente no disponibles");
  expect(screen.getByRole("alert")).toHaveTextContent("No se ha podido verificar la conexión con la web o tu acceso");
  expect(screen.queryByRole("button", { name: "Editar fuente" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Idioma" })).toBeNull();
  expect(screen.queryByTitle("InsiJets Price Index editor")).toBeNull();
});
