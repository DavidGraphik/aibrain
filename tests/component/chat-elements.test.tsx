// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "../render-spanish";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaySeparator } from "@/components/assistant-ui/elements/day-separator";
import { MemoryChips } from "@/components/assistant-ui/elements/memory-chips";
import { PermissionGrant } from "@/components/assistant-ui/elements/permission-grant";
import { TurnSourceChips } from "@/components/turn-sources";
import type { ApprovalItem } from "@/lib/chat-contract";

afterEach(cleanup);

describe("chat registry adapters", () => {
  it("groups persisted timestamps by local day and tolerates malformed dates", () => {
    const { container, rerender } = render(<DaySeparator date="2026-09-02T12:00:00Z" previousDate="2026-09-02T10:00:00Z" />);
    expect(container).toBeEmptyDOMElement();
    rerender(<DaySeparator date="2026-09-02T12:00:00Z" previousDate="2026-09-01T10:00:00Z" />);
    expect(container.querySelector("time")).toHaveAttribute("datetime", "2026-09-02T12:00:00Z");
    rerender(<DaySeparator date="invalid" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("retains source order, same-domain links and unknown document page counts", () => {
    const base = { domain: "example.com", snippet: null, publishedAt: null };
    const { container } = render(<TurnSourceChips sources={[
      { ...base, id: "web-a", kind: "web", title: "Primera fuente", url: "https://example.com/a" },
      { ...base, id: "file", kind: "file", title: "Documento local", url: null, domain: null },
      { ...base, id: "web-b", kind: "web", title: "Segunda fuente", url: "https://example.com/b" },
    ]} />);
    fireEvent.click(screen.getByText("Fuentes"));
    expect(screen.getByRole("link", { name: "Abrir fuente 1: Primera fuente" })).toHaveAttribute("href", "https://example.com/a");
    expect(screen.getByRole("link", { name: "Abrir fuente 3: Segunda fuente" })).toHaveAttribute("href", "https://example.com/b");
    expect(container.querySelector('[data-slot="document-reference"]')).toHaveTextContent("Documento local");
    expect(screen.queryByText(/páginas|Read 3|Searching/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });

  it("does not promise permanent or session grants for connector approvals", () => {
    const onResolve = vi.fn();
    const approval: ApprovalItem = { id: "approval", threadId: "thread", turnId: "turn", itemId: "item", kind: "command", title: "Enviar documento", detail: "Acción pendiente", status: "pending" };
    const { rerender } = render(<PermissionGrant approval={approval} connectorApproval onResolve={onResolve} />);
    expect(screen.queryByRole("button", { name: "Durante esta tarea" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /always|siempre/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Permitir" })).not.toBeInTheDocument();
    expect(onResolve).not.toHaveBeenCalled();
    rerender(<PermissionGrant approval={approval} readOnly onResolve={onResolve} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("Esperando la decisión de un editor del proyecto")).toBeInTheDocument();
  });

  it("keeps the exact frozen email preview inspectable without reviving a permission action", () => {
    const body = "Approved details " + "x".repeat(1600) + " END_OF_BODY";
    const preview = {
      operation: "mail_draft",
      input: { type: "create_draft", request: { subject: "Original" } },
      prepared: { action: { mailbox: "owner@example.test", request: {
        toRecipients: ["client@example.test"], ccRecipients: ["copy@example.test"],
        bccRecipients: ["private@example.test"], subject: "Frozen subject", content: body,
        attachments: ["quote.pdf"],
      } } },
    };
    const onResolve = vi.fn();
    render(<PermissionGrant approval={{ id: "mail", threadId: "thread", turnId: "turn", itemId: "item", kind: "command", title: "Correo preparado", detail: JSON.stringify(preview), status: "pending", authorizationFingerprint: "frozen-request" }} onResolve={onResolve} />);
    for (const value of ["owner@example.test", "client@example.test", "copy@example.test", "private@example.test", "Frozen subject", body, "quote.pdf"]) {
      expect(screen.getByText(value, { exact: value !== "quote.pdf" && !value.includes("@") })).toBeInTheDocument();
    }
    expect(screen.getByText("Confirma la acción en el chat")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("renders only supplied memories and exposes forgetting only when bound", () => {
    const { container, rerender } = render(<MemoryChips chips={[]} />);
    expect(container).toBeEmptyDOMElement();
    const chips = [{ id: "memory-1", text: "Prefiere respuestas breves", change: "existing" as const }];
    rerender(<MemoryChips chips={chips} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    const onForget = vi.fn();
    rerender(<MemoryChips chips={chips} onForget={onForget} />);
    fireEvent.click(screen.getByRole("button", { name: 'Olvidar "Prefiere respuestas breves"' }));
    expect(onForget).toHaveBeenCalledWith("memory-1");
  });
});
