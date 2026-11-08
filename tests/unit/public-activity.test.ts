import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolCall } from "@/components/assistant-ui/elements/tool-call";
import {
  completePublicTextPrefix,
  publicActivityText,
  publicAssistantText,
  publicCommandTitle,
  publicProjectPath,
  publicToolOutput,
} from "@/ui/public-activity";

const internalPath = "/var/lib/aibrain/data/users/fc71a2c4-0db0-4914-af82-9564038ea964/runtime/codex-home/skills/web/SKILL.md";

describe("employee-facing activity sanitization", () => {
  it("bounds the final tool presentation after short code fences expand during Markdown normalization", () => {
    const output = publicToolOutput("```x```".repeat(15_000));
    expect(output).toHaveLength(64_000);
    expect(output).toContain("Comprobación interna");
  });
  it("publishes complete words in every burst while withholding split internal tokens", () => {
    const chunks = ["Primera palabra", " segunda", " fc71a2c4-0db0-", "4914-af82-9564038ea964 texto"];
    let raw = "";
    const visible = chunks.map((chunk) => {
      raw += chunk;
      return publicAssistantText(completePublicTextPrefix(raw), "Asistente");
    });
    expect(visible).toEqual(["Primera ", "Primera palabra ", "Primera palabra segunda ",
      "Primera palabra segunda identificador interno "]);
    expect(visible.join("")).not.toContain("fc71a2c4");
    for (let split = 1; split < internalPath.length; split += 1) {
      expect(publicAssistantText(completePublicTextPrefix(`Archivo ${internalPath.slice(0, split)}`), "Asistente"))
        .toBe("Archivo ");
    }
    expect(publicAssistantText(completePublicTextPrefix(`Archivo ${internalPath} listo`), "Asistente"))
      .toBe("Archivo archivo interno ");
  });

  it("does not tie publication to the provider's burst boundaries", () => {
    let raw = "";
    let baselinePublications = 0;
    let publications = 0;
    let previous = "";
    for (let chunk = 0; chunk < 1000; chunk += 1) {
      raw += "palabra palabra";
      if (/(?:\s|[.!?…:;])$/u.test(raw)) baselinePublications += 1;
      const prefix = completePublicTextPrefix(raw);
      if (prefix !== previous) publications += 1;
      previous = prefix;
    }
    expect(baselinePublications).toBe(0);
    expect(publications).toBe(1000);
    expect(raw.length - previous.length).toBe("palabra".length);
  });
  it("removes literal Markdown, internal brands, host paths, UUIDs and installation IDs", () => {
    const result = publicActivityText([
      "**Identifying access issue**",
      `Codex inspected ${internalPath}`,
      "Instalación: company-qa",
      "request fc71a2c4-0db0-4914-af82-9564038ea964",
    ].join("\n"));

    expect(result).toContain("Identifying access issue");
    expect(result).toContain("entorno privado");
    expect(result).not.toMatch(/\*\*|Codex|AiBrain|\/var\/lib|company-qa|fc71a2c4/iu);
  });

  it("describes real command purposes without rendering the command", () => {
    const command = `/bin/sh -lc "sed -n '1,260p' ${internalPath}"`;
    expect(publicCommandTitle(command)).toBe("Consultando archivos del proyecto");
    expect(publicCommandTitle("npm run test:unit", true)).toBe("En curso: Ejecutando comprobaciones");
    expect(publicCommandTitle(command)).not.toContain("/bin/sh");
  });

  it("keeps useful output and relative project files while rejecting host paths", () => {
    expect(publicToolOutput(`12 pruebas superadas\n${internalPath}`)).toBe("12 pruebas superadas\narchivo interno");
    expect(publicProjectPath("src/components/turn-activity.tsx")).toBe("src/components/turn-activity.tsx");
    expect(publicProjectPath(internalPath)).toBeNull();
    expect(publicProjectPath("../other-user/private.txt")).toBeNull();
  });

  it("sanitizes final answers while preserving Markdown and authenticated artifact links", () => {
    const artifactUrl = "/api/projects/00000000-0000-4000-8000-000000000011/artifacts/00000000-0000-4000-8000-000000000012";
    const result = publicAssistantText(
      `## Resultado\n\nAiBrain Instalación: company-qa ${internalPath}\n\n[Abrir](${artifactUrl})`,
      "Arnall AI",
    );
    expect(result).toContain("## Resultado");
    expect(result).toContain("AiBrain entorno privado archivo interno");
    expect(result).toContain(`[Abrir](${artifactUrl})`);
    expect(result).not.toMatch(/company-qa|\/var\/lib/iu);
    expect(publicAssistantText("Hola ", "Arnall AI")).toBe("Hola ");
  });
  it("preserves literal third-party subjects, provider references and URLs across tenant brands", () => {
    const subject = "[DavidGraphik/aibrain] PR run failed: Public source quality - Use official Codex directly with per-user connections (a90d9d6)";
    const id = "12345678-1234-4234-8234-123456789abc";
    const url = "https://github.com/DavidGraphik/aibrain/actions/runs/codex-check?ref=a90d9d6";
    const text = `${subject}\nId: ${id}\nRef: codex-run_a90d9d6 aibrain_foo\n${url}\nModelo comunicado: gpt-6.1`;
    const evidence = { publicReferences: [id] };
    for (const brand of ["G03 AI", "Trinalum AI", "Arnall AI"]) {
      expect(publicAssistantText(text, brand, 128_000, evidence)).toBe(text);
      expect(publicAssistantText(publicAssistantText(text, brand, 128_000, evidence), brand, 128_000, evidence)).toBe(text);
    }
    expect(publicToolOutput(text, 64_000, evidence)).toBe(text);
    expect(publicActivityText("Codex App Server aibrain_tool")).toBe("el asistente herramienta autorizada");
  });

  it("keeps literal tool data after server and tool-card rendering with only verified IDs exempted", () => {
    const id = "12345678-1234-4234-8234-123456789abc", privateId = "fc71a2c4-0db0-4914-af82-9564038ea964";
    const source = `Codex AiBrain aibrain_foo gpt-6.1 ${id} https://example.test/api/aibrain_foo/codex?ref=${id}\nInterno: ${privateId}`;
    const output = publicToolOutput(source, 64_000, { publicReferences: [id] });
    const html = renderToStaticMarkup(createElement(ToolCall, { result: { id: "read", kind: "app", title: "G03 AI: correo", summary: null, status: "complete", output, sourceIds: [], createdAt: "2026-11-07T00:00:00Z", publicReferences: [id] } }));
    expect(html).toContain("G03 AI: correo");
    expect(html).toContain(`Codex AiBrain aibrain_foo gpt-6.1 ${id} https://example.test/api/aibrain_foo/codex?ref=${id}`);
    expect(html).not.toContain(privateId);
    expect(html).toContain("identificador interno");
  });

  it("does not introduce another customer's brand into Trinalum activity", () => {
    const result = publicAssistantText("AiBrain Instalación: trinalum-production", "Trinalum AI");
    expect(result).toBe("AiBrain entorno privado");
    expect(result).not.toContain("Arnall");
  });
});
