import { describe, expect, it } from "vitest";
import type { AdvancedArtifactSnapshot } from "@/artifacts/contracts";
import {
  ARTIFACT_PREVIEW_CSP,
  internalSiteFromMessage,
  renderArtifactHtml,
  sanitizeInternalSiteHtml,
} from "@/artifacts/rendering";

const source = {
  projectId: "0198b9f0-6631-7000-8000-000000000101",
  threadId: "0198b9f0-6631-7000-8000-000000000102",
  messageId: "0198b9f0-6631-7000-8000-000000000103",
  messageSha256: "a".repeat(64),
};

describe("advanced artifact rendering", () => {
  it("removes scripts, event handlers, active content and unsafe URLs", () => {
    const sanitized = sanitizeInternalSiteHtml(`
      <script>alert(1)</script>
      <img src=x onerror=alert(2)>
      <form action="https://attacker.example"><button>send</button></form>
      <a href="javascript:alert(3)" onclick="alert(4)">enlace</a>
      <p style="background:url(https://attacker.example)">Contenido útil</p>
    `);
    expect(sanitized).toContain("Contenido útil");
    expect(sanitized).not.toMatch(/script|onerror|onclick|javascript:|<img|<form|style=/i);
    expect(ARTIFACT_PREVIEW_CSP).toContain("script-src 'none'");
    expect(ARTIFACT_PREVIEW_CSP).toContain("connect-src 'none'");
  });

  it("escapes source Markdown and produces a script-free preview document", () => {
    const html = internalSiteFromMessage("# Informe\n\n<img src=x onerror=alert(1)>\n\n- Uno\n- Dos");
    const snapshot: AdvancedArtifactSnapshot = {
      schemaVersion: 1,
      artifactId: "0198b9f0-6631-7000-8000-000000000104",
      version: 1,
      title: "Informe interno",
      source,
      createdAt: "2026-08-28T08:00:00.000Z",
      content: { kind: "internal-site", html },
      contentSha256: "b".repeat(64),
    };
    const preview = renderArtifactHtml(snapshot);
    expect(preview).toContain("Sitio interno · acceso de empresa");
    expect(preview).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(preview).not.toContain("<script");
  });
});
