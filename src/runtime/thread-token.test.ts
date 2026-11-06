import { CONVERSATION_ATTACHMENT_DYNAMIC_TOOLS, G03_HISTORICAL_PDF_TOOLS } from './conversation-attachment-contract';
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/auth/session", () => ({
  getSigningSecret: () => "test-signing-secret-with-at-least-thirty-two-bytes",
}));

import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { SUPPORT_DYNAMIC_TOOLS, SUPPORT_INSTRUCTIONS } from "./support-tool-contract";
import { TRINALUM_DYNAMIC_TOOLS } from "./trinalum-tool-contract";
import { TRINALUM_WORKFLOW_INSTRUCTIONS } from "./trinalum-workflows";
import {
  CURRENT_THREAD_TOOLSET_REVISION,
  CURRENT_TRINALUM_THREAD_TOOLSET_REVISION,
  TRINALUM_CREATE_ONLY_AUTOMATION_TOOLSET_REVISION,
  currentThreadToolsetRevision,
  issueThreadToken,
  readThreadToken,
  readThreadTokenContext,
  toolsetRevisionForIssuedThreadToken,
} from "@/runtime/thread-token";
import { G03_PRODUCT_TOOLS, g03ProductInstructions } from "@/g03-products/chat-tools";
import { G03_SAGE_DYNAMIC_TOOLS } from "./g03-sage-tool-contract";
import { DOCUMENT_DYNAMIC_TOOLS } from "./documents/dynamic-tool-contract";
import { continuingDocumentUploads } from "@/lib/continuing-document-uploads";
import { runtimeThreadIdForChatMessage } from "@/runtime/chat-thread-selection";

describe("runtime thread token", () => {
  const userA = "00000000-0000-4000-8000-000000000001";
  const userB = "00000000-0000-4000-8000-000000000002";

  it.each([
    "aibrain-tools-2026-10-26-no-computer-use-v7",
    "aibrain-tools-2026-10-16-fleet-common-shopify-general-v9-automation-notes",
  ])("refreshes either parent catalog after reconciliation: %s", previous => {
    for (const installationId of ["trinalum-production", "g03-production", "modtime", "insijets-demo"]) {
      const suffix = installationId === "trinalum-production"
        ? `-trinalum-${"a".repeat(32)}`
        : installationId === "g03-production" ? `-g03-${"a".repeat(32)}`
        : installationId === "modtime" ? "-modtime-file-requests-v1" : "";
      const legacy = readThreadTokenContext(issueThreadToken(installationId, userA, "retained-history", previous + suffix), installationId, userA);
      expect(legacy?.threadId).toBe("retained-history");
      expect(runtimeThreadIdForChatMessage(legacy, "Continúa", installationId)).toBeNull();
      const fresh = readThreadTokenContext(issueThreadToken(installationId, userA, "fresh-runtime"), installationId, userA);
      expect(fresh).not.toBeNull();
      expect(runtimeThreadIdForChatMessage(fresh, "Continúa", installationId)).toBe("fresh-runtime");
    }
  });

  it("refreshes MODTIME conversations for file requests while retaining other installations' contracts", () => {
    const installationId = "modtime";
    const old = readThreadTokenContext(issueThreadToken(installationId, userA, "before-image-upload", CURRENT_THREAD_TOOLSET_REVISION), installationId, userA);
    expect(runtimeThreadIdForChatMessage(old, "Use the attached image", installationId)).toBeNull();
    const fresh = readThreadTokenContext(issueThreadToken(installationId, userA, "with-image-upload"), installationId, userA);
    expect(runtimeThreadIdForChatMessage(fresh, "Restore the original image", installationId)).toBe("with-image-upload");
    expect(currentThreadToolsetRevision("qa-company")).toBe(CURRENT_THREAD_TOOLSET_REVISION);
  });

  it.each(["g03-production", "g03-qa", "g03-development"])("refreshes pre-mail G03 threads and resumes the new mail contract in %s", installationId => {
    const previous = "aibrain-tools-2026-10-15-g03-chat-authorization-v1";
    const current = currentThreadToolsetRevision(installationId);
    const digest = createHash("sha256").update(JSON.stringify({ tools: G03_PRODUCT_TOOLS, instructions: g03ProductInstructions, conversationAndSourcePdfRevision: 1, sageTools: G03_SAGE_DYNAMIC_TOOLS, documentTools: DOCUMENT_DYNAMIC_TOOLS, historicalPdfTools: G03_HISTORICAL_PDF_TOOLS })).digest("hex").slice(0, 32);
    expect(current).toBe(`${CURRENT_THREAD_TOOLSET_REVISION}-g03-${digest}`);
    expect(current.length).toBeLessThanOrEqual(127);
    const preHistoricalPdf = createHash("sha256").update(JSON.stringify({ tools: G03_PRODUCT_TOOLS, instructions: g03ProductInstructions, conversationAndSourcePdfRevision: 1, sageTools: G03_SAGE_DYNAMIC_TOOLS, documentTools: DOCUMENT_DYNAMIC_TOOLS })).digest("hex").slice(0, 32);
    expect(runtimeThreadIdForChatMessage({ threadId: "before-historical-pdf", toolsetRevision: `${CURRENT_THREAD_TOOLSET_REVISION}-g03-${preHistoricalPdf}` }, "Continua", installationId)).toBeNull();
    const previousDigest = createHash("sha256").update(JSON.stringify({ tools: G03_PRODUCT_TOOLS, instructions: g03ProductInstructions })).digest("hex").slice(0, 32);
    expect(runtimeThreadIdForChatMessage({ threadId: "before-history-pdf", toolsetRevision: `${CURRENT_THREAD_TOOLSET_REVISION}-g03-${previousDigest}` }, "Resumeix el meu historial", installationId)).toBeNull();
    // This was still issued after the catalog/configuration tools shipped, but
    // cannot receive the new operations by thread/resume.
    const preManagement = readThreadTokenContext(issueThreadToken(installationId, userA, "existing-jordi-chat", `${CURRENT_THREAD_TOOLSET_REVISION}-g03-personal-mail-v4-outlook-desktop`), installationId, userA);
    expect(runtimeThreadIdForChatMessage(preManagement, "Continua", installationId)).toBeNull();
    expect(readThreadTokenContext(issueThreadToken(installationId, userA, "existing-jordi-chat"), installationId, userB)).toBeNull();
    const stale = readThreadTokenContext(issueThreadToken(installationId, userA, "thread-before-mail", previous), installationId, userA);
    expect(runtimeThreadIdForChatMessage(stale, "Responde a Jordi", installationId)).toBeNull();
    expect(runtimeThreadIdForChatMessage({ threadId: "thread-before-common", toolsetRevision: "aibrain-tools-2026-10-16-g03-personal-mail-v2" }, "Responde a Jordi", installationId)).toBeNull();
    const fresh = readThreadTokenContext(issueThreadToken(installationId, userA, "thread-with-mail"), installationId, userA);
    expect(fresh?.toolsetRevision).toBe(current);
    expect(runtimeThreadIdForChatMessage(fresh, "Responde a Jordi", installationId)).toBe("thread-with-mail");
  });

  it.each(["trinalum-production", "g03-production", "modtime", "insijets-demo"])("refreshes the computer-use catalog while retaining signed history identity in %s", installationId => {
    const previous = "aibrain-tools-2026-10-16-fleet-common-shopify-general-v6-calendar-state";
    const legacyRevision = installationId === "trinalum-production"
      ? `${previous}-trinalum-natural-v4-mail-customer-notes`
      : installationId === "modtime" ? `${previous}-modtime-file-requests-v1`
      : installationId === "g03-production" ? `${previous}-g03-old-catalog` : previous;
    const legacy = readThreadTokenContext(issueThreadToken(installationId, userA, "existing-history", legacyRevision), installationId, userA);
    expect(legacy?.threadId).toBe("existing-history");
    expect(runtimeThreadIdForChatMessage(legacy, "Continúa", installationId)).toBeNull();
    const fresh = readThreadTokenContext(issueThreadToken(installationId, userA, "refreshed-runtime"), installationId, userA);
    expect(runtimeThreadIdForChatMessage(fresh, "Continúa", installationId)).toBe("refreshed-runtime");
    expect(readThreadTokenContext(issueThreadToken(installationId, userA, "existing-history", legacyRevision), installationId, userB)).toBeNull();
  });

  it("upgrades G03 pre-Sage runtime threads without losing public history", () => {
    const oldDigest = createHash("sha256").update(JSON.stringify({ tools: G03_PRODUCT_TOOLS, instructions: g03ProductInstructions, conversationAndSourcePdfRevision: 1 })).digest("hex").slice(0,32);
    expect(runtimeThreadIdForChatMessage({ threadId: "old-runtime", toolsetRevision: `${CURRENT_THREAD_TOOLSET_REVISION}-g03-${oldDigest}` }, "Consulta Sage", "g03-production")).toBeNull();
    expect(currentThreadToolsetRevision("another-company")).toBe(CURRENT_THREAD_TOOLSET_REVISION);
  });

  it("refreshes a G03 runtime from before the document catalog and retains its original PDF on continuation", async () => {
    const installationId="g03-production";
    const oldDigest=createHash("sha256").update(JSON.stringify({tools:G03_PRODUCT_TOOLS,instructions:g03ProductInstructions,conversationAndSourcePdfRevision:1,sageTools:G03_SAGE_DYNAMIC_TOOLS})).digest("hex").slice(0,32);
    const token=issueThreadToken(installationId,userA,"old-runtime",`${CURRENT_THREAD_TOOLSET_REVISION}-g03-${oldDigest}`);
    const old=readThreadTokenContext(token,installationId,userA);
    expect(runtimeThreadIdForChatMessage(old,"Continua",installationId)).toBeNull();
    expect(readThreadTokenContext(token,installationId,userB)).toBeNull();
    const fresh=readThreadTokenContext(issueThreadToken(installationId,userA,"new-runtime"),installationId,userA);
    expect(runtimeThreadIdForChatMessage(fresh,"Continua",installationId)).toBe("new-runtime");
    const tools=DOCUMENT_DYNAMIC_TOOLS.flatMap(spec=>spec.type==="namespace"?spec.tools.map(tool=>tool.name):[]);
    expect(tools).toEqual(expect.arrayContaining(["translation_status","translation_save_page","translation_finish"]));
    expect((await import("./documents/dynamic-tools")).DOCUMENT_DYNAMIC_TOOLS).toBe(DOCUMENT_DYNAMIC_TOOLS);
    const source=await readFile(new URL("./documents/dynamic-tool-contract.ts",import.meta.url),"utf8");
    expect([...source.matchAll(/^import (?!type\b).*$/gm)]).toEqual([]);
    const pdf={id:"43361fef-08c8-45ad-aa30-8993ebd8f2f0",name:"original.pdf",mimeType:"application/pdf",size:12};
    expect(continuingDocumentUploads([{role:"user",attachments:[pdf]},{role:"assistant",attachments:[]},{role:"user",attachments:[]}])).toEqual([pdf.id]);
  });

  it("refreshes the D8 three-query Sage schema in existing G03 chats and retains the expanded schema", () => {
    const installationId="g03-production";
    const d8Digest=createHash("sha256").update(JSON.stringify({tools:G03_PRODUCT_TOOLS,instructions:g03ProductInstructions,conversationAndSourcePdfRevision:1,sageReadRevision:1})).digest("hex").slice(0,32);
    const old=readThreadTokenContext(issueThreadToken(installationId,userA,"existing-public-chat",`${CURRENT_THREAD_TOOLSET_REVISION}-g03-${d8Digest}`),installationId,userA);
    expect(old?.threadId).toBe("existing-public-chat");
    // No Sage keyword is needed: durable history is bootstrapped by the chat route.
    expect(runtimeThreadIdForChatMessage(old,"Continua",installationId)).toBeNull();
    const current=readThreadTokenContext(issueThreadToken(installationId,userA,"expanded-sage-runtime"),installationId,userA);
    expect(runtimeThreadIdForChatMessage(current,"Continua",installationId)).toBe("expanded-sage-runtime");
    for(const tenant of ["arnall","insijets-demo","another-company"]){
      expect(currentThreadToolsetRevision(tenant)).toBe(CURRENT_THREAD_TOOLSET_REVISION);
      const other=readThreadTokenContext(issueThreadToken(tenant,userA,"unchanged-other-runtime"),tenant,userA);
      expect(runtimeThreadIdForChatMessage(other,"Continua",tenant)).toBe("unchanged-other-runtime");
    }
  });

  it("refreshes pre-result-tool conversations even for a plain report follow-up", () => {
    const tenant = "trinalum-production";
    const old = readThreadTokenContext(issueThreadToken(tenant, userA, "old-report-chat", "aibrain-tools-2026-10-16-fleet-common-shopify-general-v7-automation-edit"), tenant, userA);
    expect(runtimeThreadIdForChatMessage(old, "Muestrame el de ayer", tenant)).toBeNull();
    const current = readThreadTokenContext(issueThreadToken(tenant, userA, "report-tools-chat"), tenant, userA);
    expect(runtimeThreadIdForChatMessage(current, "Muestrame el de ayer", tenant)).toBe("report-tools-chat");
  });

  it("binds a resumable Codex thread to installation and employee", () => {
    const token = issueThreadToken("qa-company", userA, "runtime-thread-1");
    expect(readThreadToken(token, "qa-company", userA)).toBe("runtime-thread-1");
    expect(readThreadTokenContext(token, "qa-company", userA)).toEqual({
      threadId: "runtime-thread-1",
      toolsetRevision: CURRENT_THREAD_TOOLSET_REVISION,
    });
    expect(readThreadToken(token, "qa-company", userB)).toBeNull();
    expect(readThreadToken(token, "other-company", userA)).toBeNull();
  });

  it("rejects tampering and invalid runtime identifiers", () => {
    const token = issueThreadToken("qa-company", userA, "runtime-thread-1");
    expect(readThreadToken(`${token}x`, "qa-company", userA)).toBeNull();
    expect(() => issueThreadToken("qa-company", userA, "../escape")).toThrow();
  });

  it("refreshes existing Trinalum tool instructions without invalidating identity or other tenants", () => {
    const installationId = "trinalum-production";
    const old = readThreadTokenContext(
      issueThreadToken(installationId, userA, "existing-conversation", CURRENT_THREAD_TOOLSET_REVISION),
      installationId,
      userA,
    );
    expect(old?.threadId).toBe("existing-conversation");
    const previousPrivateFiles = readThreadTokenContext(issueThreadToken(installationId, userA, "before-private-reader", `${CURRENT_THREAD_TOOLSET_REVISION}-trinalum-natural-v1`), installationId, userA);
    expect(runtimeThreadIdForChatMessage(previousPrivateFiles, "Lee ese PDF", installationId)).toBeNull();
    expect(runtimeThreadIdForChatMessage(old, "Continúa con la tarea", installationId)).toBeNull();
    const refreshed = readThreadTokenContext(
      issueThreadToken(installationId, userA, "refreshed-conversation"), installationId, userA,
    );
    expect(refreshed?.toolsetRevision).toBe(currentThreadToolsetRevision(installationId));
    expect(runtimeThreadIdForChatMessage(refreshed, "Continúa con la tarea", installationId)).toBe("refreshed-conversation");
    const other = readThreadTokenContext(issueThreadToken("arnall", userA, "other-conversation"), "arnall", userA);
    expect(runtimeThreadIdForChatMessage(other, "Continúa con la tarea", "arnall")).toBe("other-conversation");
    expect(readThreadTokenContext(issueThreadToken(installationId, userA, "existing-conversation"), "arnall", userA)).toBeNull();
  });

  it("accepts legacy resumable threads while marking their dynamic toolset stale", () => {
    const payload = Buffer.from(JSON.stringify({
      version: 2,
      tenantId: "qa-company",
      userId: userA,
      threadId: "runtime-thread-legacy",
      expiresAt: Date.now() + 60_000,
    })).toString("base64url");
    const signature = createHmac("sha256", "test-signing-secret-with-at-least-thirty-two-bytes")
      .update(`thread:${payload}`)
      .digest("base64url");
    expect(readThreadTokenContext(`${payload}.${signature}`, "qa-company", userA)).toEqual({
      threadId: "runtime-thread-legacy",
      toolsetRevision: null,
    });
  });

  it("keeps a resumed legacy thread stale until a new tool-enabled thread starts", () => {
    expect(toolsetRevisionForIssuedThreadToken("runtime-thread-legacy", null)).toBeNull();
    expect(readThreadTokenContext(
      issueThreadToken("qa-company", userA, "runtime-thread-legacy", null),
      "qa-company",
      userA,
    )).toEqual({ threadId: "runtime-thread-legacy", toolsetRevision: null });
    expect(toolsetRevisionForIssuedThreadToken(null, null)).toBe(CURRENT_THREAD_TOOLSET_REVISION);
  });
});


it("derives Trinalum compatibility from the pure shipped catalog and workflow guidance",async()=>{
 const contract={tools:TRINALUM_DYNAMIC_TOOLS,instructions:TRINALUM_WORKFLOW_INSTRUCTIONS,historicalAttachments:CONVERSATION_ATTACHMENT_DYNAMIC_TOOLS};
 const digest=createHash("sha256").update(JSON.stringify(contract)).digest("hex").slice(0,32);
 expect(CURRENT_TRINALUM_THREAD_TOOLSET_REVISION).toBe(`${CURRENT_THREAD_TOOLSET_REVISION}-trinalum-${digest}`);
 expect(CURRENT_TRINALUM_THREAD_TOOLSET_REVISION.length).toBeLessThanOrEqual(127);
 const action=TRINALUM_DYNAMIC_TOOLS.flatMap(spec=>spec.type==='namespace'?spec.tools:[]).find(spec=>spec.name==='sibema_action');
 expect(action?.description).toContain('create_customer_tariff');
 expect(action?.description).toContain('update_customer_tariff');
 // A later catalog or policy edit changes the identity without a manual bump.
 for(const next of [{...contract,tools:[...contract.tools,{name:'synthetic-next-capability'}]}, {...contract,instructions:contract.instructions+'\nChanged source guidance'}]){
  const changed=createHash("sha256").update(JSON.stringify(next)).digest("hex").slice(0,32);
  expect(changed).not.toBe(digest);
  expect(runtimeThreadIdForChatMessage({threadId:'before-contract-edit',toolsetRevision:`${CURRENT_THREAD_TOOLSET_REVISION}-trinalum-${changed}`},'Continúa','trinalum-production')).toBeNull();
 }
 const source=await readFile(new URL('./trinalum-tool-contract.ts',import.meta.url),'utf8');
 expect([...source.matchAll(/^import (?!type\b).*$/gm)]).toEqual([]);
});

it.each([
 "aibrain-trinalum-tools-2026-10-27-v5-native-tariffs-auto-read",
 TRINALUM_CREATE_ONLY_AUTOMATION_TOOLSET_REVISION,
 `${TRINALUM_CREATE_ONLY_AUTOMATION_TOOLSET_REVISION}-auto-read-v1`,
])("upgrades every follow-up from the fixed legacy Trinalum catalog %s",previousRevision=>{
 const installationId="trinalum-production",userId="00000000-0000-4000-8000-000000000001",otherUser="00000000-0000-4000-8000-000000000002";
 const oldToken=issueThreadToken(installationId,userId,"existing-public-chat-runtime",previousRevision);
 const previous=readThreadTokenContext(oldToken,installationId,userId);
 // Reading the authenticated old identity succeeds. Only the SDK runtime is
 // replaced; the route retains its public chat, history and current turn ACLs.
 expect(previous).toEqual({threadId:"existing-public-chat-runtime",toolsetRevision:previousRevision});
 for(const followup of ["Continúa","Hazlo","¿Y eso?","Resume el correo","Adelante, resume ese correo","Lista mis automatizaciones",""]){
  expect(runtimeThreadIdForChatMessage(previous,followup,installationId)).toBeNull();
 }
 expect(toolsetRevisionForIssuedThreadToken(previous!.threadId,previous!.toolsetRevision,installationId)).toBe(previousRevision);
 expect(readThreadTokenContext(oldToken,installationId,otherUser)).toBeNull();
 expect(readThreadTokenContext(oldToken,"other-tenant",userId)).toBeNull();
 const freshToken=issueThreadToken(installationId,userId,"new-runtime-same-public-chat");
 const fresh=readThreadTokenContext(freshToken,installationId,userId);
 expect(fresh?.toolsetRevision).toBe(CURRENT_TRINALUM_THREAD_TOOLSET_REVISION);
 expect(fresh!.toolsetRevision!.length).toBeLessThanOrEqual(127);
 for(const followup of ["Continúa","Hazlo","Lista mis automatizaciones",""]){
  expect(runtimeThreadIdForChatMessage(fresh,followup,installationId)).toBe("new-runtime-same-public-chat");
 }
 expect(readThreadTokenContext(freshToken,installationId,otherUser)).toBeNull();
 expect(readThreadTokenContext(freshToken,"other-tenant",userId)).toBeNull();
 expect(toolsetRevisionForIssuedThreadToken(null,previousRevision,installationId)).toBe(CURRENT_TRINALUM_THREAD_TOOLSET_REVISION);
});

it("refreshes existing support threads from the actual reference schema and guidance", () => {
  const digest = createHash("sha256").update(JSON.stringify({ tools: SUPPORT_DYNAMIC_TOOLS, instructions: SUPPORT_INSTRUCTIONS })).digest("hex").slice(0, 16);
  expect(CURRENT_THREAD_TOOLSET_REVISION).toBe(`aibrain-tools-2026-11-05-nc-${digest}-native-v2`);
  for (const installation of ["modtime", "g03-production", "trinalum-production", "insijets-demo"]) {
    const user = "00000000-0000-4000-8000-000000000001";
    const before = readThreadTokenContext(issueThreadToken(installation, user, "before-case-references", "aibrain-tools-2026-11-04-support-v12-schedule-start"), installation, user);
    expect(runtimeThreadIdForChatMessage(before, "Sigue fallando", installation)).toBeNull();
    const fresh = readThreadTokenContext(issueThreadToken(installation, user, "with-case-references"), installation, user);
    expect(runtimeThreadIdForChatMessage(fresh, "Sigue fallando", installation)).toBe("with-case-references");
    expect(currentThreadToolsetRevision(installation).length).toBeLessThanOrEqual(127);
  }
});

it("retires native threads that advertised installation-wide provider discovery", () => {
  const installation = "qa-company", user = "00000000-0000-4000-8000-000000000001";
  const previous = CURRENT_THREAD_TOOLSET_REVISION.replace(/-native-v2$/, "-native-v1");
  const old = readThreadTokenContext(issueThreadToken(installation, user, "with-unavailable-provider", previous), installation, user);
  expect(old).not.toBeNull();
  expect(runtimeThreadIdForChatMessage(old, "Continúa", installation)).toBeNull();
  const fresh = readThreadTokenContext(issueThreadToken(installation, user, "with-admitted-tools"), installation, user);
  expect(runtimeThreadIdForChatMessage(fresh, "Continúa", installation)).toBe("with-admitted-tools");
});

it('refreshes pre-attachment Trinalum runtime schema without changing the public chat or exposing general history',()=>{
 const previousDigest=createHash('sha256').update(JSON.stringify({tools:TRINALUM_DYNAMIC_TOOLS,instructions:TRINALUM_WORKFLOW_INSTRUCTIONS})).digest('hex').slice(0,32);
 const previousRevision=`${CURRENT_THREAD_TOOLSET_REVISION}-trinalum-${previousDigest}`;
 expect(previousRevision).not.toBe(CURRENT_TRINALUM_THREAD_TOOLSET_REVISION);
 expect(runtimeThreadIdForChatMessage({threadId:'old-runtime',toolsetRevision:previousRevision},'Continúa','trinalum-production')).toBeNull();
 expect(CONVERSATION_ATTACHMENT_DYNAMIC_TOOLS.flatMap(t=>t.type==='namespace'?t.tools.map(x=>x.name):[])).toEqual(['search_attachments','open_attachment']);
});
