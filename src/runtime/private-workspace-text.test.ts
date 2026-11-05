import { describe, expect, it } from "vitest";
import { privateWorkspaceSafeText } from "@/runtime/private-workspace-text";
import { completePublicTextPrefix, publicAssistantText } from "@/ui/public-activity";

describe("known private workspace prefixes", () => {
  it("preserves downloadable artifact links while redacting standalone internal ids", () => {
    const id = "07267fd4-0bc1-4b34-9a4c-3a023c27172b";
    const artifact = "d1358f70-ef69-434e-823b-ade88f4f21ca";
    const url = `/api/threads/${id}/artifacts/${artifact}?download=1`;
    expect(publicAssistantText(`[Descargar](${url})\nInterno: ${id}`, "Asistente"))
      .toBe(`[Descargar](${url})\nInterno: identificador interno`);
  });

  it.each(["", "&published=1"])("preserves usable G03 app links while hiding unrelated ids: %s", (query) => {
    const id = "07267fd4-0bc1-4b34-9a4c-3a023c27172b";
    const url = `/g03/apps?id=${id}${query}`;
    expect(publicAssistantText(`[Obrir aplicació](${url})\nIntern: ${id}`, "G03 AI"))
      .toBe(`[Obrir aplicació](${url})\nIntern: identificador interno`);
  });

  it.each(["/g03/production/preview", "/api/g03/apps/preview"])("preserves a functional private preview link from %s", (route) => {
    const id = "07267fd4-0bc1-4b34-9a4c-3a023c27172b";
    const url = `${route}?id=${id}`;
    const message = `[Obre la previsualització]( ${url} )\nIntern: ${id}`;
    const safe = publicAssistantText(message, "G03 AI");
    expect(safe).toBe(`[Obre la previsualització]( ${url} )\nIntern: identificador interno`);
    // The same content is sanitized while streaming and again on persistence.
    expect(publicAssistantText(safe, "G03 AI")).toBe(safe);
  });

  it.each([
    "/g03/production/preview?id=ID&token=ID",
    "/api/g03/apps/preview?id=ID&credential=ID",
    "/g03/production/preview?id=ID&published=1",
    "/api/private/g03/production/preview?id=ID",
    "/privé/g03/production/preview?id=ID",
    "/api/private?next=/g03/production/preview?id=ID",
    "/g03/production/preview?id=ID%2Fsecret",
  ])("does not exempt a preview-like URL with unreviewed paths or parameters: %s", (template) => {
    const id = "07267fd4-0bc1-4b34-9a4c-3a023c27172b";
    expect(publicAssistantText(template.replaceAll("ID", id), "G03 AI")).not.toContain(id);
  });

  it("does not exempt arbitrary internal API identifiers", () => {
    const id = "07267fd4-0bc1-4b34-9a4c-3a023c27172b";
    expect(publicAssistantText(`/api/internal/users/${id}`, "G03 AI"))
      .not.toContain(id);
  });

  it("keeps a reviewed native v7 app link functional while hiding its standalone runtime identifier", () => {
    const id = "019a0020-0000-7000-8000-000000000001";
    const url = `/g03/apps?id=${id}`;
    expect(publicAssistantText(`[Abrir](${url})\nInterno: ${id}`, "Asistente"))
      .toBe(`[Abrir](${url})\nInterno: identificador interno`);
  });

  it.each([
    '/tmp/aibrain QA_PRIVATE_MARKER tail-abc/workspace',
    '/tmp/aibrain "QA_PRIVATE_MARKER" tail-abc/workspace',
    "/tmp/aibrain 'QA_PRIVATE_MARKER' tail-abc/workspace",
  ])("withholds every partial root and replaces the complete root: %s", (root) => {
    const roots = [root, '/tmp/aibrain'];
    for (const wrapper of ['', '"', "'", '`', '(']) {
      const start = `Archivo ${wrapper}`;
      // Every cumulative character prefix covers all possible chunk splits.
      for (let split = 1; split < root.length; split++) {
        const safe = privateWorkspaceSafeText(start + root.slice(0, split), roots);
        expect(safe).toBe(split === 1 ? start + '/' : start);
        expect(publicAssistantText(completePublicTextPrefix(safe), 'Asistente'))
          .not.toContain('QA_PRIVATE_MARKER');
      }
      expect(privateWorkspaceSafeText(`${start}${root}/informe.pdf`, roots))
        .toBe(`${start}./informe.pdf`);
    }
  });

  it("keeps ordinary progressive text and replaces repeated roots", () => {
    const root = '/tmp/QA_PRIVATE_MARKER tail';
    expect(completePublicTextPrefix(privateWorkspaceSafeText('Primera palabra', [root])))
      .toBe('Primera ');
    expect(privateWorkspaceSafeText(`${root}/a y ${root}/b`, [root])).toBe('./a y ./b');
    expect(privateWorkspaceSafeText('Texto y https://example.com/docs/', [root]))
      .toBe('Texto y https://example.com/docs/');
  });
});
