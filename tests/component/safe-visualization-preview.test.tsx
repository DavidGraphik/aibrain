// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "../render-spanish";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SafeVisualizationPreview } from "@/components/safe-visualization-preview";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SafeVisualizationPreview", () => {
  it("renders a limited server-validated spec and lets an employee inspect series and values", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      snapshot: {
        content: {
          kind: "visualization",
          spec: {
            chartType: "bar",
            title: "Margen por región",
            xLabel: "Región",
            yLabel: "%",
            series: [{ name: "Actual", color: null }, { name: "Objetivo", color: null }],
            rows: [{ label: "Norte", values: [24.5, 22] }, { label: "Sur", values: [19.2, 21] }],
          },
        },
      },
    }), { status: 200 })));
    render(<SafeVisualizationPreview artifactId="0198b9f0-6631-7000-8000-000000000301" title="Margen" />);
    expect(await screen.findByText("Margen por región")).toBeInTheDocument();
    expect(screen.getByText("24,5")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Objetivo" }));
    expect(screen.getByText("22")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Norte/ }));
    expect(screen.getByRole("button", { name: /Norte/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("does not render unvalidated executable payloads", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      snapshot: { content: { kind: "visualization", spec: { script: "alert(1)" } } },
    }), { status: 200 })));
    render(<SafeVisualizationPreview artifactId="0198b9f0-6631-7000-8000-000000000302" title="No segura" />);
    expect(await screen.findByText("No se ha podido abrir esta visualización.")).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("alert(1)");
  });
});
