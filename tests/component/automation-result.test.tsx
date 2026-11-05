// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "../render-spanish";
import { afterEach, expect, it, vi } from "vitest";
import { AutomationResult } from "@/components/automation-result";
import { getThreadRequest } from "@/lib/workbench-api-client";
import type { WorkbenchThread } from "@/workbench/types";
vi.mock("@/lib/workbench-api-client", () => ({ getThreadRequest: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("opens an authorized result without requesting the owner's private project or exposing a composer", async () => {
  vi.mocked(getThreadRequest).mockResolvedValue({ id: "result-1", messages: [{ id: "answer", role: "assistant", content: "Una mejora basada en los datos", artifacts: [] }] } as unknown as WorkbenchThread);
  const close = vi.fn();
  render(<AutomationResult threadId="result-1" onClose={close} />);
  expect(await screen.findByText("Una mejora basada en los datos")).toBeInTheDocument();
  expect(getThreadRequest).toHaveBeenCalledExactlyOnceWith("result-1");
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
  expect(close).toHaveBeenCalledOnce();
});
it("shows no result when the current audience no longer authorizes the read", async () => {
  vi.mocked(getThreadRequest).mockRejectedValue(new Error("Not found"));
  render(<AutomationResult threadId="revoked" onClose={() => {}} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Comprueba que sigues teniendo acceso");
  expect(screen.queryByText("Una mejora basada en los datos")).not.toBeInTheDocument();
});
