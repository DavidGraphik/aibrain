// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "../render-spanish";
import { afterEach, describe, expect, it, vi } from "vitest";
import orderGolden from "../golden/turn-activity-order.json";
import { turnActivityScenarios } from "../fixtures/turn-activity-scenarios";
import { TurnActivity } from "@/components/turn-activity";
import timelineStyles from "@/components/assistant-ui/elements/thinking-reasoning.module.css";

afterEach(cleanup);

describe("TurnActivity timeline", () => {
  it.each(["authorizationFingerprint", "connectorAuthorizationFingerprint"] as const)("keeps a legacy Shopify %s approval inspectable without decision buttons", (fingerprintKey) => {
    const resolve = vi.fn(), approval = { id: "shopify-edit:test", threadId: "runtime-thread", turnId: "runtime-turn", itemId: "test", kind: "command" as const, title: "Change Shopify title", detail: "Draft B only", [fingerprintKey]: "a".repeat(64), status: "pending" as const };
    render(<TurnActivity message={{ ...turnActivityScenarios.multipleTools, approvals: [approval] }} onResolveApproval={resolve} />);
    expect(screen.queryByRole("button", { name: "Durante esta tarea" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Permitir" })).not.toBeInTheDocument();
    expect(resolve).not.toHaveBeenCalled();
  });
  it("collapses the same mounted live timeline when the final response arrives", () => {
    const message = turnActivityScenarios.multipleTools;
    const { rerender } = render(<TurnActivity message={message} onResolveApproval={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Mostrar el proceso de trabajo" }));
    expect(screen.getByRole("button", { name: "Ocultar el proceso de trabajo" })).toHaveAttribute("aria-expanded", "true");
    rerender(<TurnActivity message={{ ...message, status: "complete", content: "Respuesta final", durationMs: 2000 }} onResolveApproval={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Mostrar el proceso de trabajo" })).toHaveTextContent("Ha trabajado durante 0m 2s");
    // The activity component never owns or repeats the final answer.
    expect(screen.queryByText("Respuesta final")).not.toBeInTheDocument();
  });

  it("expands completed work and output in the page flow without a completion icon", () => {
    const { container } = render(<TurnActivity message={{ ...turnActivityScenarios.multipleTools, status: "complete", durationMs: 126000 }} onResolveApproval={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Mostrar el proceso de trabajo" });
    expect(trigger).toHaveTextContent("Ha trabajado durante 2m 6s");
    // Only the disclosure chevron remains: no check or reserved icon column.
    expect(trigger.querySelectorAll("svg")).toHaveLength(1);
    expect(screen.getByTestId("turn-thinking-steps")).toHaveClass(timelineStyles.completed);
    fireEvent.click(trigger);
    const region = screen.getByRole("region", { name: "Detalles del proceso de trabajo" });
    expect(region).toHaveClass(timelineStyles.pageFlow);
    expect(region).not.toHaveClass(timelineStyles.viewport);
    expect(region).toHaveAttribute("tabindex", "-1");
    fireEvent.click(screen.getByText("Ejecutando comprobaciones"));
    expect(region).toContainElement(screen.getByLabelText("Salida de Ejecutando comprobaciones"));
    expect([...container.querySelectorAll("[data-timeline-key]")].map((node) => node.getAttribute("data-timeline-key"))).toEqual(orderGolden.multipleTools);
  });

  it("keeps live activity bounded and keyboard-scrollable while it streams", () => {
    render(<TurnActivity message={turnActivityScenarios.multipleTools} onResolveApproval={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Mostrar el proceso de trabajo" }));
    const region = screen.getByRole("region", { name: "Detalles del proceso de trabajo" });
    expect(region).toHaveClass(timelineStyles.viewport);
    expect(region).not.toHaveClass(timelineStyles.pageFlow);
    expect(region).toHaveAttribute("tabindex", "0");
    expect(screen.getByTestId("turn-thinking-steps")).not.toHaveClass(timelineStyles.completed);
  });

  it("starts collapsed while running and reveals ordered tool cards only on request", () => {
    const { container } = render(
      <TurnActivity message={turnActivityScenarios.multipleTools} onResolveApproval={vi.fn()} />,
    );
    const trigger = screen.getByRole("button", { name: "Mostrar el proceso de trabajo" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: "Actividad del trabajo" })).not.toBeInTheDocument();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect([...container.querySelectorAll("[data-timeline-key]")].map((node) =>
      node.getAttribute("data-timeline-key"))).toEqual(orderGolden.multipleTools);

    const commandCard = screen.getByText("Ejecutando comprobaciones").closest("details");
    expect(commandCard).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("Ejecutando comprobaciones"));
    expect(commandCard).toHaveAttribute("open");
    expect(screen.getByLabelText("Salida de Ejecutando comprobaciones")).toHaveTextContent("12 pruebas superadas");
  });

  it("keeps details closed across live updates, completion and recovery until clicked", () => {
    const message = turnActivityScenarios.multipleTools;
    const { rerender } = render(<TurnActivity message={message} onResolveApproval={vi.fn()} />);
    for (const status of ["streaming", "complete", "streaming", "error", "streaming", "stopped"] as const) {
      rerender(<TurnActivity message={{ ...message, status, activity: [...message.activity, {
        id: `update-${status}`, kind: "tool", label: "Comprovant l’horari", status: "running",
      }] }} onResolveApproval={vi.fn()} />);
      expect(screen.getByRole("button", { name: "Mostrar el proceso de trabajo" }))
        .toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByRole("list", { name: "Actividad del trabajo" })).not.toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("button", { name: "Mostrar el proceso de trabajo" }));
    expect(screen.getByRole("button", { name: "Ocultar el proceso de trabajo" }))
      .toHaveAttribute("aria-expanded", "true");
  });

  it("collapses completed recovery activity under the measured duration", () => {
    render(<TurnActivity message={turnActivityScenarios.errorRecovery} onResolveApproval={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Mostrar el proceso de trabajo" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveTextContent("Ha trabajado durante 1m 32s");

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("list", { name: "Actividad del trabajo" })).toBeInTheDocument();
    expect(screen.getByText("He recuperado el turno durable sin repetir la acción incierta")).toBeInTheDocument();
    expect(screen.getByText("CRM · Consulta inicial")).toBeInTheDocument();
  });

  it.each(["text", "web"] as const)("renders the %s fixture without exposing private reasoning", (scenarioName) => {
    render(<TurnActivity message={turnActivityScenarios[scenarioName]} onResolveApproval={vi.fn()} />);
    expect(screen.queryByText(/chain[- ]of[- ]thought|razonamiento privado/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("turn-thinking-steps")).toBeInTheDocument();
  });

  it("sanitizes persisted activity before rendering", () => {
    const uuid = "fc71a2c4-0db0-4914-af82-9564038ea964";
    const path = `/var/lib/aibrain/data/users/${uuid}/runtime/codex-home/skills/web/SKILL.md`;
    const message = {
      ...turnActivityScenarios.text,
      activity: [{
        id: "reasoning-sensitive",
        kind: "reasoning" as const,
        label: "Raonament completat",
        detail: `**Identifying access issue** Codex ${path} Instalación: company-qa ${uuid}`,
        status: "complete" as const,
      }],
      toolResults: [{
        id: "command-sensitive",
        kind: "command" as const,
        title: `/bin/sh -lc "sed -n '1,260p' ${path}"`,
        status: "complete" as const,
        summary: "Código de salida 0",
        output: `AiBrain ${path} ${uuid}`,
        sourceIds: [],
        createdAt: "2026-08-30T10:00:02.000Z",
      }],
    };
    const { container } = render(<TurnActivity message={message} onResolveApproval={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Mostrar el proceso de trabajo" }));

    expect(screen.getByText(/Identifying access issue/)).toBeInTheDocument();
    expect(screen.getByText("Consultando archivos del proyecto")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\*\*|Codex|AiBrain|\/var\/lib|company-qa|fc71a2c4/iu);
  });
});
