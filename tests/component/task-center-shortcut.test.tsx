// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "../render-spanish";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useTaskCenterShortcut } from "@/components/use-task-center-shortcut";

afterEach(cleanup);

function TaskCenterShortcutHarness({ enabled = true }: { enabled?: boolean }) {
  const [open, setOpen] = useState(false);
  useTaskCenterShortcut(() => setOpen((current) => !current), enabled);
  return <><textarea aria-label="Editor" /><div role="status">{open ? "Centro de tareas abierto" : "Centro de tareas cerrado"}</div></>;
}

describe("useTaskCenterShortcut", () => {
  it("opens with Cmd+Option+U and closes with Ctrl+Alt+U", () => {
    render(<TaskCenterShortcutHarness />);

    fireEvent.keyDown(window, { metaKey: true, altKey: true, code: "KeyU" });
    expect(screen.getByRole("status")).toHaveTextContent("Centro de tareas abierto");

    fireEvent.keyDown(window, { ctrlKey: true, altKey: true, code: "KeyU" });
    expect(screen.getByRole("status")).toHaveTextContent("Centro de tareas cerrado");
  });

  it("does not toggle while another modal surface owns focus", () => {
    render(<TaskCenterShortcutHarness enabled={false} />);
    fireEvent.keyDown(window, { metaKey: true, altKey: true, code: "KeyU" });
    expect(screen.getByRole("status")).toHaveTextContent("Centro de tareas cerrado");
  });

  it("does not steal the shortcut from an editable control", () => {
    render(<TaskCenterShortcutHarness />);
    const editor = screen.getByRole("textbox", { name: "Editor" });
    editor.focus();
    fireEvent.keyDown(editor, { metaKey: true, altKey: true, code: "KeyU" });
    expect(screen.getByRole("status")).toHaveTextContent("Centro de tareas cerrado");
  });
});
