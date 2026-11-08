// @vitest-environment jsdom

import { render, screen } from "../render-spanish";
import { describe, expect, it } from "vitest";
import { publicAssistantText } from "@/ui/public-activity";
import { MarkdownMessage, splitStreamingMarkdown } from "@/components/markdown-message";

describe("MarkdownMessage", () => {
  it('keeps completed plain heading/paragraph nodes at terminal state, and resolves complex references in the full final document', () => {
    const content = '### Primero\n\nPárrafo terminado.\n\n### Segundo\n\nÚltimo párrafo.';
    const { rerender, container } = render(<MarkdownMessage streaming>{content}</MarkdownMessage>);
    const heading = screen.getByRole('heading', { name: 'Primero' });
    const paragraph = screen.getByText('Párrafo terminado.');
    rerender(<MarkdownMessage>{content}</MarkdownMessage>);
    expect(screen.getByRole('heading', { name: 'Primero' })).toBe(heading);
    expect(screen.getByText('Párrafo terminado.')).toBe(paragraph);
    expect(container.querySelector('.t-stream-caret')).toBeNull();
    rerender(<MarkdownMessage>{'[Fuente][ref]\n\n[ref]: https://example.test'}</MarkdownMessage>);
    expect(screen.getByRole('link', { name: 'Fuente' })).toHaveAttribute('href', 'https://example.test');
  });
  it("renders GFM tables, links, lists and labelled code blocks", () => {
    render(<MarkdownMessage>{[
      "## Resultado",
      "- Primer punto",
      "- Segundo punto",
      "  - Subpunto",
      "",
      "1. Paso uno",
      "2. Paso dos",
      "",
      "- [x] Validado",
      "",
      "Texto con ~~contenido anterior~~ y `código inline`.",
      "",
      "| Estado | Valor |",
      "| --- | --- |",
      "| Listo | Sí |",
      "",
      "[Referencia](https://example.test)",
      "",
      "```ts",
      "const ready = true;",
      "```",
    ].join("\n")}</MarkdownMessage>);

    expect(screen.getByRole("heading", { name: "Resultado" })).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("Validado").closest("li")).toHaveClass("task-list-item");
    expect(screen.getByText("contenido anterior").tagName).toBe("DEL");
    expect(screen.getByText("código inline").tagName).toBe("CODE");
    expect(screen.getByRole("link", { name: "Referencia" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("button", { name: "Copiar bloque de código" })).toBeInTheDocument();
    expect(screen.getByText("const ready = true;")).toBeInTheDocument();
  });

  it("renders the invoice table's line breaks without enabling active HTML", () => {
    const { container } = render(<MarkdownMessage>{"| Factura y albarán | A reclamar |\n| --- | --- |\n| M26/007811<br>M26/042664 | 3,01 € |\n\n<script>alert(1)</script>"}</MarkdownMessage>);
    expect(container.querySelector("td br")).not.toBeNull();
    expect(container.querySelector("td")?.textContent).toBe("M26/007811\nM26/042664");
    expect(container.querySelector("script")).toBeNull();
  });

  it("shows streamed prose immediately with one lightweight caret and no word wrappers", () => {
    const longAnswer = Array.from({ length: 1_000 }, (_, index) => `palabra-${index}`).join(" ");
    const { container, rerender } = render(
      <MarkdownMessage streaming>{longAnswer}</MarkdownMessage>,
    );

    expect(container.querySelector(".t-stream")).toBeInTheDocument();
    expect(container.querySelectorAll(".t-stream-w")).toHaveLength(0);
    expect(container.querySelectorAll(".t-stream-caret")).toHaveLength(1);
    expect(container.textContent).toContain("palabra-999");

    rerender(<MarkdownMessage>{longAnswer}</MarkdownMessage>);
    expect(container.querySelector(".t-stream-caret")).not.toBeInTheDocument();
  });

  it("freezes completed Markdown blocks but keeps fenced code together", () => {
    expect(splitStreamingMarkdown([
      "Primer párrafo.",
      "",
      "Segundo párrafo.",
      "",
      "```ts",
      "const first = true;",
      "",
      "const second = true;",
      "```",
      "",
      "Final en curso",
    ].join("\n"))).toEqual([
      "Primer párrafo.",
      "Segundo párrafo.",
      "```ts\nconst first = true;\n\nconst second = true;\n```",
      "Final en curso",
    ]);
  });
});

it("keeps server-issued history references clickable after public redaction without exposing raw UUIDs", () => {
  const url = "/conversations/ERERERERQRGBEREREREREQ";
  const rawId = "11111111-1111-4111-8111-111111111111";
  const content = publicAssistantText(`[Revisión del 23/10](${url})\n\nInterno: ${rawId}`, "Asistente");
  render(<MarkdownMessage>{content}</MarkdownMessage>);
  expect(screen.getByRole("link", { name: "Revisión del 23/10" })).toHaveAttribute("href", url);
  expect(screen.queryByText(rawId)).not.toBeInTheDocument();
  expect(content).toContain("identificador interno");
});
