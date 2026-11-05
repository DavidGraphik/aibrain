import { describe, expect, it } from "vitest";
import { applyChatStreamEvent, isToolResult, type ChatMessage } from "@/lib/chat-contract";
import { MAX_PUBLIC_REFERENCES, observedToolPublicReferences, publicReferencesForResults, validPublicReferences } from "./public-references";
import { itemToolResult } from "@/runtime/codex-app-server";
import { completePublicTextPrefix, publicAssistantText, publicToolOutput } from "@/ui/public-activity";

const RECORD = "8dd76778-9efa-4b62-9d89-c73c78f40341";
const V7 = "019a0020-0000-7000-8000-000000000005";
const PRIVATE = "019a0020-0000-7000-8000-000000000001";
const DIGEST = "e2".repeat(32);
const NUMERIC = "1234567890123456789012345678901234";
const at = "2026-11-05T00:00:00.000Z";
const dynamic = (payload: unknown) => ({ id: "connector-call", type: "dynamicToolCall", status: "completed", success: true,
  namespace: "business_records", tool: "read", contentItems: [{ type: "inputText", text: JSON.stringify(payload) }] });
const project = (payload: unknown) => itemToolResult({ threadId: PRIVATE, item: dynamic(payload) }, true, at, [PRIVATE])!;

describe("observed business references through display boundaries", () => {
  it("preserves external UUID versions, numeric references and checksums through backend, frontend and replay", () => {
    const result = project({ records: [{ id: RECORD }, { record_uuid: V7 }, { id: NUMERIC, checksum: DIGEST }] });
    expect(result.publicReferences).toEqual([RECORD, V7, NUMERIC, DIGEST]);
    expect(isToolResult(result)).toBe(true);
    for (const reference of [RECORD, V7, NUMERIC, DIGEST]) expect(result.output).toContain(reference);
    const initial: ChatMessage = { id: PRIVATE, role: "assistant", content: "", status: "streaming", createdAt: at,
      activity: [], plan: [], approvals: [], diff: "", attachments: [], artifacts: [] };
    const stored = applyChatStreamEvent(initial, { type: "toolResult", item: result });
    const evidence = { publicReferences: publicReferencesForResults(JSON.parse(JSON.stringify(stored)).toolResults), privateReferences: [PRIVATE] };
    const text = `Registro ${RECORD}; UUID ${V7}; factura ${NUMERIC}; checksum sha256:${DIGEST}. Interno: ${PRIVATE}`;
    const backend = publicAssistantText(text, "Asistente", 128_000, evidence);
    expect(publicAssistantText(backend, "Asistente", 128_000, evidence)).toBe(backend);
    for (const reference of [RECORD, V7, NUMERIC, DIGEST]) expect(backend).toContain(reference);
    expect(backend).not.toContain(PRIVATE);
    expect(publicAssistantText(text, "Asistente")).not.toMatch(new RegExp(`${RECORD}|${V7}|${DIGEST}|${NUMERIC}`));
  });

  it("works with a native structured MCP result without depending on a connector name", () => {
    const item = { id: "native-call", type: "mcpToolCall", status: "completed", error: null, server: "another-provider",
      result: { structuredContent: { data: { external_record_id: RECORD, digest: DIGEST } }, content: [] } };
    expect(observedToolPublicReferences(item, true)).toEqual([RECORD, DIGEST]);
    expect(observedToolPublicReferences({ ...item, status: "inProgress" }, true)).toEqual([]);
    expect(observedToolPublicReferences({ ...item, result: { ...item.result, isError: true } }, true)).toEqual([]);
  });

  it("requires a successful result and structured identity fields, never free prose or model-supplied evidence", () => {
    for (const item of [
      { ...dynamic({ id: RECORD }), success: false },
      { ...dynamic({ id: RECORD }), success: undefined },
      { ...dynamic({ id: RECORD }), status: "failed" },
      { ...dynamic({ id: RECORD }), status: "running" },
      dynamic({ success: false, records: [{ id: RECORD }] }),
      dynamic({ ok: false, records: [{ id: RECORD }] }),
      dynamic({ isError: true, records: [{ id: RECORD }] }),
      dynamic({ error: "Unavailable", records: [{ id: RECORD }] }),
      dynamic({ publicReferences: [RECORD], description: RECORD }),
      dynamic({ content: `record_id: ${RECORD}` }),
      { ...dynamic(null), contentItems: [{ type: "inputText", text: `Record ID: ${RECORD}` }] },
      { ...dynamic({ id: RECORD }), type: "commandExecution", aggregatedOutput: JSON.stringify({ id: RECORD }) },
    ]) expect(observedToolPublicReferences(item, false)).toEqual([]);
    expect(observedToolPublicReferences(dynamic({ input: { id: RECORD } }), true)).toEqual([]);
    expect(observedToolPublicReferences({ ...dynamic({ id: RECORD }), status: "running" }, true)).toEqual([]);
    expect(observedToolPublicReferences(dynamic({ input: { id: RECORD }, record: { id: RECORD } }), true)).toEqual([RECORD]);
  });

  it("vetoes private context and secret/runtime branches even when a provider also labels the same value as a record", () => {
    for (const key of ["accessToken", "refresh_token", "password", "sessionId", "runtime", "metadata", "internal", "private", "debug", "profile", "connector", "threadId", "permissionFingerprint", "publicReferences"]) {
      const payload = { records: [{ id: RECORD }, { id: PRIVATE }], [key]: { value: RECORD } };
      expect(project(payload).publicReferences).toBeUndefined();
    }
    const result = project({ records: [{ id: PRIVATE }, { id: RECORD }], credential: DIGEST, digest: DIGEST });
    expect(result.publicReferences).toEqual([RECORD]);
    expect(result.output).not.toContain(PRIVATE);
    expect(result.output).not.toContain(DIGEST);
    const forced = { publicReferences: [PRIVATE], privateReferences: [PRIVATE] };
    expect(publicAssistantText(`Registro ${PRIVATE}`, "Asistente", 128_000, forced)).not.toContain(PRIVATE);
  });

  it("never restores host paths, internal APIs or explicitly private fields with a valid reference exemption", () => {
    const evidence = { publicReferences: [RECORD, DIGEST] };
    for (const text of [`/var/lib/company/${RECORD}`, `file:///tmp/${RECORD}`, `/api/internal/users/${RECORD}`, `token: ${RECORD}`, `runtimeId="${RECORD}"`]) {
      expect(publicAssistantText(text, "Asistente", 128_000, evidence)).not.toContain(RECORD);
    }
    expect(publicAssistantText(`fingerprint: ${DIGEST}`, "Asistente", 128_000, evidence)).not.toContain(DIGEST);
    const url = `/api/threads/${PRIVATE}/artifacts/${RECORD}?download=1`;
    expect(publicAssistantText(`[Descargar](${url})`, "Asistente", 128_000, evidence)).toBe(`[Descargar](${url})`);
    expect(publicToolOutput(`Identificador ${RECORD}`, 64_000, evidence)).toContain(RECORD);
  });

  it("withholds every partial UUID, numeric reference and digest across arbitrary streaming cuts", () => {
    const evidence = { publicReferences: [RECORD, V7, NUMERIC, DIGEST], privateReferences: [PRIVATE] };
    for (const value of [RECORD, V7, NUMERIC, DIGEST, PRIVATE]) {
      for (let cut = 1; cut < value.length; cut += 1) {
        expect(publicAssistantText(completePublicTextPrefix(`Referencia ${value.slice(0, cut)}`), "Asistente", 128_000, evidence)).toBe("Referencia ");
      }
      const visible = publicAssistantText(completePublicTextPrefix(`Referencia ${value} `), "Asistente", 128_000, evidence);
      expect(visible).toBe(`Referencia ${value === PRIVATE ? "identificador interno" : value} `);
    }
    const text = `Consulta /var/lib/company/${PRIVATE}/workspace resultado ${RECORD} `;
    for (let cut = 1; cut <= text.length; cut += 1) {
      const output = publicAssistantText(completePublicTextPrefix(text.slice(0, cut)), "Asistente", 128_000, evidence);
      expect(output).not.toContain(PRIVATE);
      expect(output).not.toContain("/var/lib");
    }
  });

  it("projects all126 synthetic CRM records before the64K display cap and rejects oversized evidence as a whole", () => {
    const records = Array.from({ length: 126 }, (_, index) => ({ id: `019a0020-0000-7000-8000-${String(index + 100).padStart(12, "0")}`, description: "x".repeat(700) }));
    const result = project({ records });
    expect(result.publicReferences).toHaveLength(126);
    expect(result.output!.length).toBeLessThanOrEqual(64_000);
    expect(publicAssistantText(records.at(-1)!.id, "Asistente", 128_000, { publicReferences: result.publicReferences })).toBe(records.at(-1)!.id);
    const tooMany = Array.from({ length: MAX_PUBLIC_REFERENCES + 1 }, (_, index) => ({ id: `019a0020-0000-7000-8000-${String(index + 100).padStart(12, "0")}` }));
    expect(observedToolPublicReferences(dynamic({ records: tooMany }), true)).toEqual([]);
    expect(observedToolPublicReferences(dynamic({ id: RECORD, text: "x".repeat(1_048_576) }), true)).toEqual([]);
  });

  it("bounds wire evidence, ignores incomplete carriers and preserves older tool contracts", () => {
    const result = project({ id: RECORD });
    expect(validPublicReferences([RECORD, RECORD.toUpperCase()])).toBe(false);
    expect(validPublicReferences([DIGEST, `sha256:${DIGEST}`])).toBe(false);
    expect(isToolResult({ ...result, publicReferences: ["/etc/private"] })).toBe(false);
    expect(isToolResult({ ...result, status: "running" })).toBe(false);
    expect(publicReferencesForResults([{ ...result, status: "failed" }])).toEqual([]);
    const { publicReferences: _references, ...older } = result;
    expect(isToolResult(older)).toBe(true);
    expect(publicReferencesForResults([older])).toEqual([]);
  });
});
