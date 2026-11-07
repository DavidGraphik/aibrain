// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "../../tests/render-spanish";
import { afterEach, expect, it, vi } from "vitest";
import { TextDialog } from "./workbench-dialogs";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("keeps an immediately entered project name when the opening focus frame runs", () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const submit = vi.fn();
  render(<TextDialog open title="New project" label="Project name" submitLabel="Create project" busy={false} onClose={() => {}} onSubmit={submit} />);
  const input = screen.getByLabelText("Project name");
  fireEvent.change(input, { target: { value: "QA project" } });
  act(() => { for (const frame of frames) frame(0); });
  expect(input).toHaveFocus();
  expect(input).toHaveValue("QA project");
  expect(screen.getByRole("button", { name: "Create project" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));
  expect(submit).toHaveBeenCalledExactlyOnceWith("QA project");
});

it("preserves a draft across parent updates and resets it for a new opening or initial value", () => {
  const props = { title: "Rename", label: "Name", submitLabel: "Save", busy: false, onClose: () => {}, onSubmit: vi.fn() };
  const { rerender } = render(<TextDialog {...props} open initialValue="First" />);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "My draft" } });
  rerender(<TextDialog {...props} open initialValue="First" busy />);
  expect(screen.getByLabelText("Name")).toHaveValue("My draft");
  rerender(<TextDialog {...props} open={false} initialValue="First" />);
  expect(screen.queryByRole("dialog")).toBeNull();
  rerender(<TextDialog {...props} open initialValue="First" />);
  expect(screen.getByLabelText("Name")).toHaveValue("First");
  rerender(<TextDialog {...props} open initialValue="Second" />);
  expect(screen.getByLabelText("Name")).toHaveValue("Second");
});
