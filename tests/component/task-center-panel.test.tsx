// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "../render-spanish";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskCenterPanel } from "@/components/task-center-panel";
import type { TaskCenterItem } from "@/task-center/contracts";

const task: TaskCenterItem = {
  id: "0198b9f0-6631-7000-8000-000000000401.0198b9f0-6631-7000-8000-000000000402",
  threadId: "0198b9f0-6631-7000-8000-000000000401",
  projectId: "0198b9f0-6631-7000-8000-000000000403",
  threadTitle: "Informe semanal",
  projectName: "Operaciones",
  status: "completed",
  title: "Informe preparado",
  detail: "El resultado ya está disponible en la conversación.",
  createdAt: "2026-08-28T08:00:00.000Z",
  updatedAt: "2026-08-28T08:00:00.000Z",
  unread: true,
};

function TaskCenterHarness() {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={() => setOpen(true)}>Abrir tareas</button>
    <TaskCenterPanel open={open} tasks={[]} preferences={{ inApp: true, desktop: false }} notificationPermission="default" busy={false} onClose={() => setOpen(false)} onOpenConversation={() => undefined} onMarkRead={() => undefined} onMarkAllRead={() => undefined} onPreferencesChange={() => undefined} onRequestDesktopNotifications={() => undefined} />
  </>;
}

afterEach(cleanup);

describe("TaskCenterPanel", () => {
  it("closes on Escape, restores focus, and removes its exiting drawer from a11y", async () => {
    render(<TaskCenterHarness />);
    const opener = screen.getByRole("button", { name: "Abrir tareas" });
    opener.focus();
    fireEvent.click(opener);
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Centro de tareas" })).toBeInTheDocument());

    fireEvent.keyDown(document, { key: "Escape" });
    const exiting = document.querySelector('[data-overlay-presence="exiting"]');
    expect(exiting).toHaveAttribute("inert");
    expect(exiting).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("dialog", { name: "Centro de tareas" })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("shows durable history, filters and read actions", () => {
    const markRead = vi.fn();
    render(<TaskCenterPanel open tasks={[task]} preferences={{ inApp: true, desktop: false }} notificationPermission="default" busy={false} onClose={() => undefined} onOpenConversation={() => undefined} onMarkRead={markRead} onMarkAllRead={() => undefined} onPreferencesChange={() => undefined} onRequestDesktopNotifications={() => undefined} />);
    expect(screen.getByText("Informe preparado")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Marcar como leída" }));
    expect(markRead).toHaveBeenCalledWith(task.id);
    fireEvent.click(screen.getByRole("button", { name: /En curso/ }));
    expect(screen.getByText("Todo al día")).toBeInTheDocument();
  });

  it("requests browser permission only after the employee explicitly enables it", () => {
    const requestPermission = vi.fn();
    render(<TaskCenterPanel open tasks={[]} preferences={{ inApp: true, desktop: false }} notificationPermission="default" busy={false} onClose={() => undefined} onOpenConversation={() => undefined} onMarkRead={() => undefined} onMarkAllRead={() => undefined} onPreferencesChange={() => undefined} onRequestDesktopNotifications={requestPermission} />);
    expect(requestPermission).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Preferencias de notificaciones" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Avisos del navegador/ }));
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });
});
