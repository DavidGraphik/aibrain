// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "../render-spanish";
import { afterEach, describe, expect, it } from "vitest";
import { ToolResultList } from "@/components/tool-result-list";
import { TurnSourceChips, TurnSourceList } from "@/components/turn-sources";

const source = {
  id: "source-1", kind: "web" as const, title: "Informe oficial",
  url: "https://example.com/informe", domain: "example.com", snippet: "Cifra publicada",
  publishedAt: "2026-08-20T00:00:00.000Z",
};

afterEach(cleanup);

describe("turn evidence UI", () => {
  it("renders an accessible inline citation and detailed source", () => {
    render(<><TurnSourceChips sources={[source]} /><TurnSourceList sources={[source]} /></>);
    const region = screen.getByRole("region", { name: "Fuentes de la respuesta" });
    const disclosure = region.querySelector("details");
    expect(disclosure).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("Fuentes"));
    expect(disclosure).toHaveAttribute("open");
    expect(screen.getAllByRole("link", { name: "Abrir fuente 1: Informe oficial" })[0]).toHaveAttribute("href", source.url);
    expect(screen.getByText("Cifra publicada")).toBeInTheDocument();
  });

  it("states honestly when no source metadata exists", () => {
    render(<TurnSourceList sources={[]} />);
    expect(screen.getByText("Sin fuentes verificables")).toBeInTheDocument();
    expect(screen.getByText(/no crea citas/i)).toBeInTheDocument();
  });

  it("keeps a real tool output expandable and readable", () => {
    render(<ToolResultList results={[{
      id: "tool-1", kind: "app", title: "CRM · Leer cuenta", status: "complete",
      summary: "crm", output: "Cuenta encontrada", sourceIds: [source.id],
      createdAt: "2026-08-28T09:00:00.000Z",
    }]} />);
    expect(screen.getByText("CRM · Leer cuenta")).toBeInTheDocument();
    expect(screen.getByLabelText("Salida de CRM · Leer cuenta")).toHaveTextContent("Cuenta encontrada");
  });

  it("reads historical browser output without reopening the retired feature", () => {
    render(<ToolResultList results={[{
      id: "tool-browser", kind: "browser", title: "Navegador · open", status: "complete",
      summary: "browser", output: null, sourceIds: [], createdAt: "2026-08-30T09:00:00.000Z",
    }]} />);
    expect(screen.getByText("Navegador · open")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reabrir/ })).toBeNull();
  });
});
