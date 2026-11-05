// @vitest-environment jsdom

import { cleanup, render, screen } from "../render-spanish";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManagedAppActionControl } from "@/components/managed-app-action-control";
import type { ChatMessage } from "@/lib/chat-contract";

const message: ChatMessage = {
  id: "turn-current",
  role: "assistant",
  content: "Resultado visible",
  status: "complete",
  createdAt: "2026-08-28T12:00:00.000Z",
  activity: [], plan: [], approvals: [], diff: "", attachments: [], artifacts: [], sources: [], toolResults: [],
};

const descriptor = {
  operation: "execute-allowlisted-action",
  locator: { threadId: "thread-current", turnId: "turn-current", itemId: "turn-current", approvalId: "turn-current" },
  authorizationFingerprint: "a".repeat(64),
  approval: {
    id: "turn-current", threadId: "thread-current", turnId: "turn-current", itemId: "turn-current",
    kind: "command", title: "Confirmar acción conectada", detail: "Ejecutar la acción aprobada de la aplicación conectada.", status: "pending",
  },
} as const;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ManagedAppActionControl", () => {
  it("has no consumer until the connected capability gate is true", () => {
    const { rerender } = render(<ManagedAppActionControl enabled={false} threadId="thread-current" message={message} onPrepared={() => undefined} />);
    expect(screen.queryByRole("button", { name: "Solicitar aprobación" })).not.toBeInTheDocument();

    rerender(<ManagedAppActionControl enabled threadId="thread-current" message={message} onPrepared={() => undefined} />);
    expect(screen.queryByRole("button", { name: "Solicitar aprobación" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Acción conectada" })).toBeVisible();
  });

  it("directs the employee to chat without creating a button approval or sending a mutation", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ schemaVersion: 1, descriptor })));
    vi.stubGlobal("fetch", fetcher);
    const onPrepared = vi.fn();
    render(<ManagedAppActionControl enabled threadId="thread-current" message={message} onPrepared={onPrepared} />);

    expect(screen.getByText(/Pide al asistente en el chat/)).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(onPrepared).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
