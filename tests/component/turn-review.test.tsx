// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "../render-spanish";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DetailsPanel } from "@/components/details-panel";
import reasoningStyles from "@/components/assistant-ui/elements/thinking-reasoning.module.css";
import { TurnActivity } from "@/components/turn-activity";
import type { ChatMessage } from "@/lib/chat-contract";

const message: ChatMessage = {
  id: "message-1",
  role: "assistant",
  content: "## Resultado",
  createdAt: "2026-08-27T00:00:00.000Z",
  status: "complete",
  plan: [
    { step: "Revisar el proyecto", status: "completed" },
    { step: "Aplicar el cambio", status: "in_progress" },
  ],
  activity: [{
    id: "command-1",
    kind: "command",
    label: "Comprobar estado",
    detail: "Comprobación sintética terminada",
    output: "ok",
    status: "complete",
  }],
  approvals: [{
    id: "approval-1",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    kind: "command",
    title: "Ejecutar comprobación",
    detail: "Solo lee el estado sintético.",
    command: "check --synthetic",
    cwd: "/workspace/synthetic",
    status: "pending",
  }],
  diff: [
    "diff --git a/resultado.txt b/resultado.txt",
    "--- a/resultado.txt",
    "+++ b/resultado.txt",
    "@@ -1 +1 @@",
    "-Pendiente",
    "+Completado",
  ].join("\n"),
  attachments: [],
  artifacts: [],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("turn activity and Review", () => {
  it("shows live progress, updates it in place and compacts it when the turn completes", () => {
    const liveMessage: ChatMessage = {
      ...message,
      status: "streaming",
      plan: [],
      approvals: [],
      diff: "",
      activity: [
        { ...message.activity[0], id: "runtime-context", kind: "system", label: "Context preparat", detail: "Memòria, permisos i documents", status: "complete" },
        { ...message.activity[0], id: "runtime-performance", kind: "system", label: "Rendiment del torn", detail: "Primer text 30508 ms · Total 45918 ms · Worker calent", status: "complete" },
        { ...message.activity[0], id: "reasoning-1", kind: "reasoning", label: "Raonament completat", detail: "Identificando el alcance exacto", status: "complete" },
        { ...message.activity[0], id: "file-1", kind: "file", label: "Preparant canvis", detail: "src/components/turn-activity.tsx", status: "running" },
      ],
    };
    const { rerender } = render(<TurnActivity
      message={liveMessage}
      onResolveApproval={vi.fn()}
    />);
    let trigger = screen.getByRole("button", { name: "Mostrar el proceso de trabajo" });

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveTextContent("Preparando cambios en src/components/turn-activity.tsx");
    expect(trigger.querySelector(`.${reasoningStyles.shimmer}`)).toBeInTheDocument();
    expect(screen.getByText("Identificando el alcance exacto")).toBeInTheDocument();
    expect(screen.queryByText("Contexto preparado")).not.toBeInTheDocument();
    expect(screen.queryByText(/Primer text 30508 ms/)).not.toBeInTheDocument();

    rerender(<TurnActivity
      message={{
        ...liveMessage,
        activity: [
          { ...liveMessage.activity[0] },
          { ...liveMessage.activity[1], status: "complete" },
          { ...liveMessage.activity[2] },
          { ...liveMessage.activity[3], status: "complete" },
          { ...message.activity[0], id: "command-1", kind: "command", label: "Executant una ordre", detail: "npm run typecheck", status: "running" },
        ],
      }}
      onResolveApproval={vi.fn()}
    />);

    trigger = screen.getByRole("button", { name: "Ocultar el proceso de trabajo" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveTextContent("En curso: Validando el proyecto");
    expect(trigger.querySelector(`.${reasoningStyles.shimmer}`)).toBeInTheDocument();

    rerender(<TurnActivity
      message={{
        ...liveMessage,
        status: "complete",
        activity: [
          { ...liveMessage.activity[0] },
          { ...liveMessage.activity[1], status: "complete" },
          { ...liveMessage.activity[2] },
          { ...liveMessage.activity[3], status: "complete" },
          { ...message.activity[0], id: "command-1", kind: "command", label: "Ordre executada", detail: "npm run typecheck", status: "complete" },
        ],
      }}
      onResolveApproval={vi.fn()}
    />);

    trigger = screen.getByRole("button", { name: "Mostrar el proceso de trabajo" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveTextContent("Ha trabajado durante 0m 46s");
    expect(trigger.querySelector(`.${reasoningStyles.shimmer}`)).not.toBeInTheDocument();
    expect(screen.getByText("Identificando el alcance exacto")).not.toBeVisible();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Identificando el alcance exacto")).toBeInTheDocument();
  });

  it("keeps runtime failures visible while hiding successful lifecycle telemetry", () => {
    render(<TurnActivity
      message={{
        ...message,
        plan: [],
        approvals: [],
        diff: "",
        activity: [
          { id: "runtime-context", kind: "system", label: "Context preparat", status: "complete" },
          { id: "runtime-turn-recovery", kind: "system", label: "No s’ha pogut recuperar el torn", detail: "App Server no ha retornat el torn", status: "failed" },
        ],
      }}
      onResolveApproval={vi.fn()}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Mostrar el proceso de trabajo" }));
    expect(screen.getByText(/No se ha podido completar: No se ha podido recuperar la tarea/)).toBeInTheDocument();
    expect(screen.queryByText("Contexto preparado")).not.toBeInTheDocument();
  });

  it("presents plan, command output, diff and approval decisions in employee language", () => {
    const onResolve = vi.fn();
    render(<TurnActivity message={message} onResolveApproval={onResolve} />);

    expect(screen.getByText("Revisar el proyecto")).toBeInTheDocument();
    expect(screen.getByText("Comprobar estado")).toBeInTheDocument();
    expect(screen.getByText("Comprobación sintética terminada")).toBeInTheDocument();
    expect(screen.getByText("Cambios preparados")).toBeInTheDocument();
    const approval = screen.getByRole("group", { name: "Aprobación: Ejecutar comprobación" });
    expect(within(approval).queryByRole("button", { name: "Permitir" })).not.toBeInTheDocument();
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("keeps activity and Review inspectable in read-only mode without approval mutations", () => {
    const onResolve = vi.fn();
    const onOpenReview = vi.fn();
    render(<TurnActivity
      message={message}
      readOnly
      onResolveApproval={onResolve}
      onOpenReview={onOpenReview}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Mostrar el proceso de trabajo" }));
    expect(screen.getByText("Comprobar estado")).toBeInTheDocument();
    expect(screen.getByText("Esperando la decisión de un editor del proyecto")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Permitir" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rechazar" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Abrir cambios y resultados" }));
    expect(onOpenReview).toHaveBeenCalledOnce();
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("opens the real edited file inside the activity", async () => {
    const fetchPreview = vi.fn(async () => new Response(JSON.stringify({
      file: {
        path: "src/example.ts",
        name: "example.ts",
        kind: "text",
        mimeType: "text/plain",
        size: 26,
        language: "TypeScript",
        content: "export const ready = true;",
        previewUrl: null,
        previewMimeType: "text/plain",
        downloadUrl: "/api/projects/00000000-0000-4000-8000-000000000001/files?path=src%2Fexample.ts&download=1",
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchPreview);
    render(<TurnActivity
      projectId="00000000-0000-4000-8000-000000000001"
      message={{
        ...message,
        status: "streaming",
        plan: [],
        approvals: [],
        diff: "",
        activity: [{
          id: "file-preview-1",
          kind: "file",
          label: "Preparant canvis",
          detail: "src/example.ts",
          files: [{ path: "src/example.ts", change: "update" }],
          status: "running",
        }],
      }}
      onResolveApproval={vi.fn()}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Mostrar el proceso de trabajo" }));
    fireEvent.click(screen.getByRole("button", { name: /src\/example\.ts/ }));
    await waitFor(() => {
      expect(screen.getByText("export const ready = true;")).toBeVisible();
    });
    expect(fetchPreview).toHaveBeenCalledWith(
      "/api/projects/00000000-0000-4000-8000-000000000001/files?path=src%2Fexample.ts",
      { headers: { Accept: "application/json" } },
    );
  });

  it("keeps connector outcomes auditable and removes session-wide approval", () => {
    const connectorApproval = { ...message.approvals[0], id: "connector-approval", title: "Confirmar acción conectada" };
    render(<TurnActivity
      message={{
        ...message,
        approvals: [connectorApproval],
        toolResults: [{
          id: "managed-app:connector-approval", kind: "app", title: "Acción conectada", status: "failed",
          summary: "indeterminate", output: null, sourceIds: [], createdAt: "2026-08-28T12:00:00.000Z",
        }],
      }}
      onResolveApproval={vi.fn()}
      managedAppApprovalKeys={[JSON.stringify(["thread-1", "turn-1", "item-1", "connector-approval"])]}
    />);

    expect(screen.queryByRole("button", { name: "Durante esta tarea" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mostrar el proceso de trabajo" }));
    const toolTitle = screen.getByText("Acción conectada");
    const toolCard = toolTitle.closest("details");
    fireEvent.click(toolTitle);
    expect(toolCard).toHaveAttribute("open");
    expect(screen.getByText("indeterminate")).toBeInTheDocument();
  });

  it("renders an inspectable file diff and activity tabs", () => {
    render(<DetailsPanel message={message} open onClose={vi.fn()} onResolveApproval={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Cambios y resultados del turno" })).toBeInTheDocument();
    expect(screen.getAllByText("resultado.txt")).toHaveLength(2);
    expect(screen.getAllByText("+1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("−1").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /Actividad/ }));
    expect(screen.getByText("Comprobar estado")).toBeInTheDocument();
  });

  it("keeps the read-only inspector auditable without approval decisions", () => {
    const onResolve = vi.fn();
    render(<DetailsPanel message={message} open readOnly onClose={vi.fn()} onResolveApproval={onResolve} />);

    fireEvent.click(screen.getByRole("button", { name: /Actividad/ }));
    expect(screen.getByText("Esperando la decisión de un editor del proyecto")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Permitir" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rechazar" })).not.toBeInTheDocument();
    expect(onResolve).not.toHaveBeenCalled();
  });
});
