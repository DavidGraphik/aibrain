// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "../render-spanish";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SupportDialog } from "@/components/support-dialog";

function SupportDialogHarness() {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={() => setOpen(true)}>Abrir ayuda</button>
    <SupportDialog open={open} projectId="project-1" threadId="thread-1" onClose={() => setOpen(false)} />
  </>;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SupportDialog", () => {
  it("preserves the draft but clears transient errors when reopened", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Error temporal" }, { status: 500 })));
    render(<SupportDialogHarness />);

    const opener = screen.getByRole("button", { name: "Abrir ayuda" });
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Ayuda y feedback" });
    expect(dialog).toHaveClass("flex", "overflow-hidden");
    expect(dialog.querySelector("form")).toHaveClass("min-h-0", "overflow-y-auto");
    fireEvent.click(screen.getByRole("button", { name: "Bug" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Descripción" }), {
      target: { value: "El panel no responde" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Error temporal"));

    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    fireEvent.click(opener);

    expect(screen.getByRole("button", { name: "Bug" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("textbox", { name: "Descripción" })).toHaveValue("El panel no responde");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

function mockSupportFetch(requests: unknown[] = []) {
  const post = vi.fn(async () => Response.json({ request: { id: "request-1" } }, { status: 201 }));
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST" ? post() : Response.json({ requests }));
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
  return { fetcher, post };
}

it("reuses the submission identity after a failed response and reopening", async () => {
  const { fetcher, post } = mockSupportFetch();
  post.mockImplementationOnce(async () => { throw new Error("Conexión interrumpida"); });
  render(<SupportDialogHarness />);
  fireEvent.click(screen.getByRole("button", { name: "Abrir ayuda" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Descripción" }), { target: { value: "No puedo importar" } });
  fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Conexión interrumpida"));
  fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
  fireEvent.click(screen.getByRole("button", { name: "Abrir ayuda" }));
  fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Solicitud recibida"));
  const sends = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
  expect(sends).toHaveLength(2);
  const payloads = sends.map(([, init]) => JSON.parse(String(init?.body)));
  expect(payloads[0].clientRequestId).toMatch(/^[a-f\d-]{36}$/i);
  expect(payloads[1]).toEqual(payloads[0]);
});

it("shows support replies and continues a resolved request without creating another", async () => {
  const { fetcher } = mockSupportFetch([{
    id: "request-1", description: "No puedo importar", status: "resolved", screenshots: [],
    messages: [{ id: "message-1", author: "support", body: "Ya puedes importar el archivo.", createdAt: "2026-11-04T08:00:00Z" }],
  }]);
  render(<SupportDialogHarness />);
  fireEvent.click(screen.getByRole("button", { name: "Abrir ayuda" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Mis solicitudes (1)" })).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "Mis solicitudes (1)" }));
  fireEvent.click(screen.getByRole("button", { name: /Resuelta. No puedo importar/ }));
  expect(screen.getByText("Ya puedes importar el archivo.")).toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox", { name: "¿Necesitas continuar con esta solicitud?" }), { target: { value: "Este otro archivo sigue fallando" } });
  fireEvent.click(screen.getByRole("button", { name: "Enviar respuesta" }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "¿Necesitas continuar con esta solicitud?" })).toHaveValue(""));
  const sends = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
  expect(sends).toHaveLength(1);
  expect(sends[0][0]).toBe("/api/support/request-1/reply");
  expect(JSON.parse(String(sends[0][1]?.body))).toEqual({ body: "Este otro archivo sigue fallando", clientRequestId: expect.any(String) });
});

it("includes explicitly attached captures and preserves them after a failed send", async () => {
  const { fetcher, post } = mockSupportFetch();
  post.mockImplementation(async () => { throw new Error("Sin conexión"); });
  render(<SupportDialogHarness />);
  fireEvent.click(screen.getByRole("button", { name: "Abrir ayuda" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Descripción" }), { target: { value: "Mira esta captura" } });
  const image = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "error.png", { type: "image/png" });
  fireEvent.change(screen.getByLabelText("Capturas de pantalla"), { target: { files: [image] } });
  await waitFor(() => expect(screen.getByText("error.png")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Sin conexión"));
  const sends = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
  const payload = JSON.parse(String(sends[0][1]?.body));
  expect(payload.screenshots).toEqual([{ name: "error.png", mimeType: "image/png", dataUrl: expect.stringMatching(/^data:image\/png;base64,/) }]);
  fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
  fireEvent.click(screen.getByRole("button", { name: "Abrir ayuda" }));
  expect(screen.getByText("error.png")).toBeInTheDocument();
});

it("rejects unsupported images and oversized captures before submission", async () => {
  const { fetcher } = mockSupportFetch();
  render(<SupportDialogHarness />);
  fireEvent.click(screen.getByRole("button", { name: "Abrir ayuda" }));
  fireEvent.change(screen.getByLabelText("Capturas de pantalla"), { target: { files: [new File(["<svg/>"], "test.svg", { type: "image/svg+xml" })] } });
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Usa capturas PNG, JPEG o WebP."));
  fireEvent.change(screen.getByLabelText("Capturas de pantalla"), { target: { files: [new File([new Uint8Array(2 * 1024 * 1024 + 1)], "large.png", { type: "image/png" })] } });
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Cada captura puede ocupar hasta 2 MB."));
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
});

it("preserves a failed reply and its identity when support is reopened", async () => {
  const { fetcher, post } = mockSupportFetch([{ id: "request-1", description: "No puedo importar", status: "needs_information", screenshots: [], messages: [] }]);
  post.mockImplementationOnce(async () => { throw new Error("Sin conexión"); });
  render(<SupportDialogHarness />);
  fireEvent.click(screen.getByRole("button", { name: "Abrir ayuda" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Mis solicitudes (1)" })).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "Mis solicitudes (1)" }));
  fireEvent.click(screen.getByRole("button", { name: /Necesitamos más información. No puedo importar/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "Añadir información" }), { target: { value: "Ocurre al subir este CSV" } });
  fireEvent.click(screen.getByRole("button", { name: "Enviar respuesta" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Sin conexión"));
  fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
  fireEvent.click(screen.getByRole("button", { name: "Abrir ayuda" }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Añadir información" })).toHaveValue("Ocurre al subir este CSV"));
  fireEvent.click(screen.getByRole("button", { name: "Enviar respuesta" }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Añadir información" })).toHaveValue(""));
  const sends = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
  expect(sends).toHaveLength(2);
  expect(sends[0][1]?.body).toBe(sends[1][1]?.body);
});
