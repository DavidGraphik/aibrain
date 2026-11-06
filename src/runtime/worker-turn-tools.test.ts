import { describe, expect, it, vi } from "vitest";
import { buildWorkerTurnTools, type WorkerTurnToolsContext } from "./worker-turn-tools";
import { DOCUMENT_DYNAMIC_TOOLS } from "./documents/dynamic-tools";
import { GMAIL_DYNAMIC_TOOLS } from "./gmail-dynamic-tools";
import { OUTLOOK_DYNAMIC_TOOLS } from "./outlook-dynamic-tools";
import { SUPPORT_DYNAMIC_TOOLS, SUPPORT_INSTRUCTIONS } from "./support-tool-contract";
import { G03_PRODUCT_TOOLS, G03_PRODUCT_READ_TOOLS, PRODUCTION_NAMESPACE, g03ProductInstructions } from "@/g03-products/chat-tools";
import { G03_DYNAMIC_TOOLS, g03Instructions } from "@/g03/dynamic-tools";
import { HORARIA_TOOLS, horariaInstructions } from "@/horaria/chat-tools";
import { AUTOMATION_DYNAMIC_TOOLS } from "@/automations/chat-tools";
import { AUTOMATION_RUN_STATE_TOOLS, AUTOMATION_RUN_STATE_INSTRUCTIONS } from "@/automations/run-state-tools";
import { COMPANY_FILES_DYNAMIC_TOOLS } from "./enterprise-documents/dynamic-tools";
import { MAIL_DYNAMIC_TOOLS } from "./mail-dynamic-tools";
import { OUTLOOK_DESKTOP_DYNAMIC_TOOLS } from "./outlook-desktop-dynamic-tools";
import { WEBSITE_CHAT_TOOLS } from "@/insijets/website-chat-edit";
import { OPERATOR_CHAT_TOOLS, operatorChatInstructions } from "@/insijets/operator-sourcing-chat";
import { OUTREACH_SYSTEM_TOOLS, outreachSystemInstructions } from "@/insijets/outreach-system-chat";
import { COMPOSIO_NAMESPACE } from "./composio-dynamic-tools";

vi.mock("server-only", () => ({}));

function context(): WorkerTurnToolsContext {
  return {
    installationId: "synthetic-company", connectors: undefined,
    sessions: { identity: false, automation: false, g03: false },
    execution: { background: false, automationStateAvailable: false },
    documentNetworkAvailable: false,
    modules: { websiteDemo: false, trinalumBridge: false, modtimeReporting: false },
    preparedTools: { operators: [], outreach: [] },
  };
}
const names = (specs: ReturnType<typeof buildWorkerTurnTools>["dynamicTools"]) => specs.map(spec => spec.name);
const containsSpecs = (actual: ReturnType<typeof buildWorkerTurnTools>["dynamicTools"], expected: readonly { name: string }[]) => {
  expect(names(actual)).toEqual(expect.arrayContaining(expected.map(spec => spec.name)));
};
const withoutSpecs = (actual: ReturnType<typeof buildWorkerTurnTools>["dynamicTools"], expected: readonly { name: string }[]) => {
  for (const spec of expected) expect(names(actual)).not.toContain(spec.name);
};

describe("turn module catalogue", () => {
  it("does not offer Composio discovery for native-only users, but keeps a verified Composio connection", () => {
    const input = context();
    input.connectors = { composio: { toolkits: [{ slug: "example_crm", label: "Example CRM", authConfigId: "ac_example", scopes: ["read"], readTools: [{ slug: "EXAMPLE_READ", version: "20261106_01" }] }] } };
    input.availableConnectorIds = [];
    expect(names(buildWorkerTurnTools(input).dynamicTools)).not.toContain(COMPOSIO_NAMESPACE);
    input.availableConnectorIds = ["native-gmail", "native-google-drive", "native-google-calendar"];
    expect(names(buildWorkerTurnTools(input).dynamicTools)).not.toContain(COMPOSIO_NAMESPACE);
    input.availableConnectorIds = ["composio-example-crm"];
    expect(names(buildWorkerTurnTools(input).dynamicTools)).toContain(COMPOSIO_NAMESPACE);
    input.availableConnectorIds = undefined;
    expect(names(buildWorkerTurnTools(input).dynamicTools)).not.toContain(COMPOSIO_NAMESPACE);
  });
  it("only announces direct mail providers present in the fresh server connection snapshot", () => {
    const input = context(); input.availableConnectorIds = [];
    withoutSpecs(buildWorkerTurnTools(input).dynamicTools, [...GMAIL_DYNAMIC_TOOLS, ...OUTLOOK_DYNAMIC_TOOLS]);
    input.availableConnectorIds = ["gmail"];
    containsSpecs(buildWorkerTurnTools(input).dynamicTools, GMAIL_DYNAMIC_TOOLS);
    withoutSpecs(buildWorkerTurnTools(input).dynamicTools, OUTLOOK_DYNAMIC_TOOLS);
    input.availableConnectorIds = ["outlook"];
    containsSpecs(buildWorkerTurnTools(input).dynamicTools, OUTLOOK_DYNAMIC_TOOLS);
    withoutSpecs(buildWorkerTurnTools(input).dynamicTools, GMAIL_DYNAMIC_TOOLS);
  });
  it("keeps the stable base catalogue without assuming a live provider connection", () => {
    const plan = buildWorkerTurnTools(context());
    expect(plan.dynamicTools).toEqual([...DOCUMENT_DYNAMIC_TOOLS, ...GMAIL_DYNAMIC_TOOLS, ...OUTLOOK_DYNAMIC_TOOLS]);
    expect(plan.developerInstructions).toEqual([]);
    expect(plan.automationRunStateInstructions).toEqual([]);
    expect(plan.desktopOutlookEnabled).toBe(false);
  });

  it.each([false, true])("uses the same support decision for tools and instructions (background=%s)", background => {
    const input = context(); input.installationId = "trinalum-production";
    input.sessions.identity = true; input.execution.background = background;
    const plan = buildWorkerTurnTools(input);
    expect(plan.developerInstructions.includes(SUPPORT_INSTRUCTIONS)).toBe(!background);
    if (background) withoutSpecs(plan.dynamicTools, SUPPORT_DYNAMIC_TOOLS);
    else containsSpecs(plan.dynamicTools, SUPPORT_DYNAMIC_TOOLS);
    containsSpecs(plan.dynamicTools, HORARIA_TOOLS);
    expect(plan.developerInstructions).toContain(horariaInstructions);
  });

  it.each([false, true])("keeps authenticated product scope and read-only background tools (background=%s)", background => {
    const input = context(); input.installationId = "g03-production";
    input.sessions.identity = true; input.execution.background = background;
    const plan = buildWorkerTurnTools(input);
    expect(plan.dynamicTools.filter(spec => G03_PRODUCT_TOOLS.some(product => product.name === spec.name)))
      .toEqual(background ? G03_PRODUCT_READ_TOOLS : G03_PRODUCT_TOOLS);
    expect(plan.developerInstructions).toContain(g03ProductInstructions);
    const history = plan.dynamicTools.find(spec => spec.name === "aibrain_conversations");
    expect(history?.type).toBe("namespace");
    if (history?.type === "namespace") {
      expect(history.tools.some(tool => tool.name === "reference_historical_pdf")).toBe(!background);
    }
  });

  it("does not register product tools or instructions from an installation name alone", () => {
    const input = context(); input.installationId = "g03-production";
    const plan = buildWorkerTurnTools(input);
    withoutSpecs(plan.dynamicTools, G03_PRODUCT_TOOLS);
    expect(plan.developerInstructions).not.toContain(g03ProductInstructions);
    withoutSpecs(plan.dynamicTools, G03_DYNAMIC_TOOLS);
    expect(plan.developerInstructions).not.toContain(g03Instructions);
  });

  it("keeps G03, automation and scheduling admission independently scoped", () => {
    const input = context(); input.sessions.g03 = true; input.sessions.automation = true;
    const plan = buildWorkerTurnTools(input);
    containsSpecs(plan.dynamicTools, [...G03_DYNAMIC_TOOLS, ...AUTOMATION_DYNAMIC_TOOLS, ...HORARIA_TOOLS]);
    expect(plan.developerInstructions).toEqual([horariaInstructions, g03Instructions]);
    withoutSpecs(plan.dynamicTools, G03_PRODUCT_TOOLS);
    withoutSpecs(plan.dynamicTools, SUPPORT_DYNAMIC_TOOLS);
  });

  it.each([false, true])("admits durable automation state only outside host analysis (host=%s)", host => {
    const input = context(); input.execution.background = true; input.execution.automationStateAvailable = true;
    if (host) input.execution.hostAnalysisPolicy = { businessReads: true, webSearch: false };
    const plan = buildWorkerTurnTools(input);
    expect(plan.automationRunStateInstructions).toEqual(host ? [] : [AUTOMATION_RUN_STATE_INSTRUCTIONS]);
    if (host) withoutSpecs(plan.dynamicTools, AUTOMATION_RUN_STATE_TOOLS);
    else containsSpecs(plan.dynamicTools, AUTOMATION_RUN_STATE_TOOLS);
    input.execution.background = false;
    withoutSpecs(buildWorkerTurnTools(input).dynamicTools, AUTOMATION_RUN_STATE_TOOLS);
  });

  it("replaces every normal module with the restricted support-preview catalogue without mutating shared specs", () => {
    const input = context(); input.installationId = "g03-production";
    input.sessions = { identity: true, automation: true, g03: true };
    input.documentNetworkAvailable = true; input.preparedTools = { operators: OPERATOR_CHAT_TOOLS, outreach: OUTREACH_SYSTEM_TOOLS };
    input.execution.hostAnalysisPolicy = {
      businessReads: true, webSearch: true,
      supportPreview: { installationId: input.installationId, userId: "synthetic-user", sessionHash: "a".repeat(64), supportActorEmail: "support@example.test", supportExpiresAt: "2026-11-06T00:00:00Z", publicThreadId: "synthetic-thread", previewAppId: "synthetic-preview" },
    };
    const before = JSON.stringify(G03_PRODUCT_TOOLS);
    const plan = buildWorkerTurnTools(input);
    expect(plan.dynamicTools).toHaveLength(1);
    expect(plan.dynamicTools[0].name).toBe(PRODUCTION_NAMESPACE);
    const production = plan.dynamicTools[0];
    expect(production.type).toBe("namespace");
    if (production.type === "namespace") expect(production.tools.map(tool => tool.name)).toEqual(["read", "mutate"]);
    expect(JSON.stringify(G03_PRODUCT_TOOLS)).toBe(before);
  });

  it.each(["g03-production", "synthetic-company"])("keeps document and mail admission explicit (%s)", installationId => {
    const input = context(); input.installationId = installationId; input.documentNetworkAvailable = true;
    input.connectors = { mail: { enabled: true, provider: "nominalia" } };
    const plan = buildWorkerTurnTools(input);
    containsSpecs(plan.dynamicTools, [...COMPANY_FILES_DYNAMIC_TOOLS, ...MAIL_DYNAMIC_TOOLS]);
    expect(plan.desktopOutlookEnabled).toBe(installationId === "g03-production");
    expect(plan.developerInstructions.some(text => text.startsWith("G03 personal Outlook:"))).toBe(plan.desktopOutlookEnabled);
    if (plan.desktopOutlookEnabled) containsSpecs(plan.dynamicTools, OUTLOOK_DESKTOP_DYNAMIC_TOOLS);
    else withoutSpecs(plan.dynamicTools, OUTLOOK_DESKTOP_DYNAMIC_TOOLS);
  });

  it("keeps website demo tools and guidance behind both identity and installation gates", () => {
    const input = context(); input.modules.websiteDemo = true;
    for (const installationId of ["synthetic-company", "insijets-demo"]) {
      for (const identity of [false, true]) {
        input.installationId = installationId; input.sessions.identity = identity;
        const plan = buildWorkerTurnTools(input), enabled = identity && installationId === "insijets-demo";
        expect(plan.developerInstructions.some(text => text.startsWith("The insijets_website_local_review"))).toBe(enabled);
        if (enabled) containsSpecs(plan.dynamicTools, WEBSITE_CHAT_TOOLS);
        else withoutSpecs(plan.dynamicTools, WEBSITE_CHAT_TOOLS);
      }
    }
  });

  it("preserves already-admitted operator/outreach tools and never manufactures them", () => {
    const input = context();
    const empty = buildWorkerTurnTools(input);
    withoutSpecs(empty.dynamicTools, [...OPERATOR_CHAT_TOOLS, ...OUTREACH_SYSTEM_TOOLS]);
    input.preparedTools = { operators: OPERATOR_CHAT_TOOLS, outreach: OUTREACH_SYSTEM_TOOLS };
    const admitted = buildWorkerTurnTools(input);
    containsSpecs(admitted.dynamicTools, [...OPERATOR_CHAT_TOOLS, ...OUTREACH_SYSTEM_TOOLS]);
    expect(admitted.developerInstructions).toEqual([operatorChatInstructions, outreachSystemInstructions]);
  });
});
