// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "../render-spanish";
import { afterEach, expect, it, vi } from "vitest";
import { ServerPicker } from "@/components/server-picker";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const folder = { path: "server-arnall/Y/QA", name: "QA", kind: "directory", modifiedAt: null, size: 0, scope: "company" };
function reply(results: object[]) { return { ok: true, json: async () => ({ available: true, sourceChecked: true, checkedAt: new Date().toISOString(), results, nextQuery: null }) }; }
it("navigates, refreshes external changes and attaches folder references without reading content", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply([folder])).mockResolvedValueOnce(reply([{ ...folder, path: "server-arnall/Y/QA/New.txt", name: "New.txt", kind: "file" }])).mockResolvedValueOnce(reply([{ ...folder, path: "server-arnall/Y/QA/Changed.txt", name: "Changed.txt", kind: "file" }]));
  vi.stubGlobal("fetch", fetcher);
  const select = vi.fn(); const close = vi.fn();
  render(<ServerPicker projectId="project" selected={[]} onSelect={select} onClose={close}/>);
  fireEvent.click(await screen.findByLabelText("Adjuntar QA"));
  fireEvent.click(screen.getByRole("button", { name: "Abrir QA" }));
  await screen.findByText("New.txt");
  fireEvent.click(screen.getByLabelText("Actualizar desde Windows"));
  await screen.findByText("Changed.txt");
  expect(screen.queryByText("New.txt")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Adjuntar referencias" }));
  expect(select).toHaveBeenCalledWith([{ path: folder.path, name: "QA", kind: "directory", modifiedAt: null, size: 0 }]);
  expect(close).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls.every(([url]) => String(url).startsWith("/api/server-files?"))).toBe(true);
});
it("does not present cached results as a live folder", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ available: true, sourceChecked: false, results: [folder] }) }));
  render(<ServerPicker projectId="project" selected={[]} onSelect={vi.fn()} onClose={vi.fn()}/>);
  await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  expect(screen.queryByText("QA")).toBeNull();
});

it("escapes a transformed composer, labels drives and restores focus when closed", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply([{ ...folder, path: "server-arnall/C/", name: "C" }])));
  const trigger = document.createElement("button"); document.body.append(trigger); trigger.focus();
  const view = render(<div style={{ transform: "translateY(1px)" }}><ServerPicker projectId="project" selected={[]} onSelect={vi.fn()} onClose={vi.fn()}/></div>);
  await screen.findByText("Unidad C:");
  expect(screen.getByTestId("server-backdrop").parentElement).toBe(document.body);
  expect(screen.queryByLabelText("Adjuntar C")).toBeNull();
  expect(screen.getByRole("dialog").getAttribute("aria-modal")).toBe("true");
  view.unmount(); expect(document.activeElement).toBe(trigger); trigger.remove();
});

it("returns focus to a stable trigger when the opening menu item has unmounted", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply([])));
  const trigger = document.createElement("button"); document.body.append(trigger);
  const menuItem = document.createElement("button"); document.body.append(menuItem); menuItem.focus();
  const view = render(<ServerPicker projectId="project" selected={[]} onSelect={vi.fn()} onClose={vi.fn()} returnFocus={{current:trigger}}/>);
  await screen.findByRole("dialog"); menuItem.remove(); view.unmount();
  expect(document.activeElement).toBe(trigger); trigger.remove();
});

it("opens work-folder shortcuts without calling them live files and keeps all drives reachable", async () => {
  const home = { ok: true, json: async () => ({ available: true, navigation: true, sourceChecked: false, checkedAt: null, results: [{ ...folder, name: "Compres" }], nextQuery: null }) };
  const fetcher = vi.fn().mockResolvedValueOnce(home).mockResolvedValueOnce(reply([{ ...folder, path: "server-arnall/C/", name: "C" }, { ...folder, path: "server-arnall/Y/", name: "Y" }]));
  vi.stubGlobal("fetch", fetcher);
  render(<ServerPicker projectId="project" selected={[]} onSelect={vi.fn()} onClose={vi.fn()}/>);
  await screen.findByText("Compres");
  expect(fetcher.mock.calls[0][0]).toContain("query=home");
  expect(screen.queryByLabelText("Adjuntar Compres")).toBeNull();
  expect(screen.queryByText(/Consultado:/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Explorar unidades" }));
  await screen.findByText("Unidad C:");
  expect(screen.getByText("Unidad Y:")).toBeTruthy();
  expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
});

it("reads a selected work folder fresh and can select/deselect a supported file", async () => {
  const home = { ok: true, json: async () => ({ available: true, navigation: true, sourceChecked: false, checkedAt: null, results: [folder], nextQuery: null }) };
  const fetcher = vi.fn().mockResolvedValueOnce(home).mockResolvedValueOnce(reply([{ ...folder, name: "test.txt", path: "server-arnall/Y/QA/test.txt", kind: "file" }]));
  vi.stubGlobal("fetch", fetcher);
  const select = vi.fn();
  render(<ServerPicker projectId="project" selected={[]} onSelect={select} onClose={vi.fn()}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Abrir QA" }));
  const checkbox = await screen.findByLabelText("Adjuntar test.txt");
  fireEvent.click(checkbox);
  expect(screen.getByRole("button", { name: "Adjuntar referencias" }).hasAttribute("disabled")).toBe(false);
  fireEvent.click(checkbox);
  expect(screen.getByRole("button", { name: "Adjuntar referencias" }).hasAttribute("disabled")).toBe(true);
  expect(select).not.toHaveBeenCalled();
});
