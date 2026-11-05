import { describe, expect, it } from "vitest";
import { isChatStreamEvent } from "@/lib/chat-contract";
import { itemActivity, itemSources, itemToolResult } from "@/runtime/codex-app-server";

const observedAt = "2026-08-28T09:00:00.000Z";

describe("runtime source and tool result projection", () => {
  it("projects only explicit HTTP(S) web result metadata", () => {
    const params = { item: {
      id: "web-1", type: "webSearch", query: "informe",
      results: [
        { title: "Informe oficial", url: "https://example.com/report", snippet: "Cifra publicada", date: "2026-08-20" },
        { title: "No segura", url: "javascript:alert(1)" },
        { title: "Sin URL", snippet: "No debe citarse" },
      ],
    } };
    expect(itemSources(params)).toEqual([expect.objectContaining({
      kind: "web", title: "Informe oficial", url: "https://example.com/report",
      domain: "example.com", snippet: "Cifra publicada", publishedAt: "2026-08-20T00:00:00.000Z",
    })]);
    expect(itemToolResult(params, true, observedAt)).toMatchObject({
      kind: "web", status: "complete", summary: "1 fuente consultada",
      sourceIds: [itemSources(params)[0]?.id],
    });
  });

  it("keeps real MCP text, errors and linked resources reviewable", () => {
    const params = { completedAtMs: Date.parse(observedAt), item: {
      id: "mcp-1", type: "mcpToolCall", server: "crm", tool: "read_account", status: "completed",
      appContext: { appName: "CRM", actionName: "Leer cuenta" },
      result: {
        content: [
          { type: "text", text: "Cuenta encontrada" },
          { type: "resource_link", name: "Ficha", uri: "https://crm.example/account/1", description: "Cuenta 1" },
        ],
        structuredContent: null,
      },
      error: null,
    } };
    expect(itemSources(params)).toEqual([expect.objectContaining({ kind: "app", title: "Ficha" })]);
    expect(itemToolResult(params, true, observedAt)).toMatchObject({
      kind: "app", title: "CRM · Leer cuenta", output: "Cuenta encontrada", createdAt: observedAt,
    });
  });

  it("does not fabricate a source for a command or a web result without a URL", () => {
    expect(itemSources({ item: { id: "command-1", type: "commandExecution", command: "pwd" } })).toEqual([]);
    expect(itemSources({ item: { id: "web-2", type: "webSearch", results: [{ title: "Sin enlace" }] } })).toEqual([]);
  });

  it("normalizes terminal control bytes before durable projection", () => {
    const params = { item: {
      id: "command-pdf", type: "commandExecution", command: "pdftotext file.pdf -",
      status: "completed", exitCode: 0, aggregatedOutput: "Pages: 1\n\f\u0000",
    } };
    const result = itemToolResult(params, true, observedAt);
    const activity = itemActivity(params, true);

    expect(result?.output).toBe("Pages: 1\n��");
    expect(activity?.output).toBe("Pages: 1\n��");
    expect(isChatStreamEvent({ type: "toolResult", item: result })).toBe(true);
    expect(isChatStreamEvent({ type: "activity", item: activity })).toBe(true);
  });

  it("projects commands and outputs without internal runtime details", () => {
    const uuid = "fc71a2c4-0db0-4914-af82-9564038ea964";
    const path = `/var/lib/aibrain/data/users/${uuid}/runtime/codex-home/skills/web/SKILL.md`;
    const params = { item: {
      id: "command-sensitive",
      type: "commandExecution",
      command: `/bin/sh -lc "sed -n '1,260p' ${path}"`,
      status: "completed",
      exitCode: 0,
      aggregatedOutput: `Instalación: company-qa\nCodex\n${path}\n${uuid}`,
    } };

    const result = itemToolResult(params, true, observedAt);
    const activity = itemActivity(params, true);
    expect(result?.title).toBe("Consultando archivos del proyecto");
    expect(activity?.detail).toBe("Consultando archivos del proyecto");
    expect(JSON.stringify({ result, activity })).not.toMatch(/\/bin\/sh|\/var\/lib|company-qa|Codex|fc71a2c4/iu);
    expect(result?.output).toContain("entorno privado");
    expect(result?.output).not.toContain("Arnall");
  });
});
