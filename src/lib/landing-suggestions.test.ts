import { describe, expect, it } from "vitest";
import { translate, type UiText } from "@/i18n/messages";
import { landingSuggestions, scheduledPromptTemplates } from "@/lib/landing-suggestions";

const english: UiText = (source, values) => translate("en", source, values);
const knownInstallations = ["arnall", "company-qa", "insijets-demo", "trinalum-production", "modtime"];

describe("landing prompt templates", () => {
  it.each(["arnall", "company-qa"])("preserves Arnall scheduling for its explicit %s identity regardless of connectors", (installationId) => {
    expect(landingSuggestions(null, "Arnall", { installationId, gmailAuthorized: true })).toEqual(scheduledPromptTemplates("Arnall"));
    expect(landingSuggestions(null, "Arnall", { installationId })).toEqual(scheduledPromptTemplates("Arnall"));
    const schedule = landingSuggestions(null, "Renamed brand", { installationId })[2];
    expect(schedule.id).toBe("schedule");
    expect(schedule.children).toHaveLength(3);
    expect(schedule.children?.[0].prompt).toContain("revisar los destinatarios y los mensajes antes de enviarlos");
  });

  it("offers Luca’s three outreach prompts only for InsiJets", () => {
    const suggestions = landingSuggestions(null, "MODTIME", { installationId: "insijets-demo" }, english);
    expect(suggestions.map(item => item.id)).toEqual(["outreach-campaigns", "outreach-leads", "outreach-attention"]);
    expect(suggestions.map(item => item.label)).toEqual(["What campaigns are we running?", "Prepare more qualified leads", "What needs my attention?"]);
    expect(suggestions[0].prompt).toBe("What campaigns are we running?");
    expect(suggestions[1].prompt).toBe("Prepare 1000 more qualified leads using the agreed ICP mix. Propose the plan and estimated cost first; do not source, spend, upload or send without the required approval.");
    expect(suggestions[2].prompt).toBe("What needs my attention in outreach today?");
    expect(suggestions.every(item => !item.children && !item.action)).toBe(true);
  });

  it("preserves the existing approved Trinalum CRM, ERP and document prompts", () => {
    const suggestions = landingSuggestions(null, "Arnall", { installationId: "trinalum-production" });
    expect(suggestions).toEqual([
      { id: "trinalum-crm", label: "Consultar Attio", prompt: "Consulta Attio y muéstrame las tareas abiertas, responsables y próximos pasos. Solo lectura." },
      { id: "trinalum-erp", label: "Consultar Sibema", prompt: "Quiero consultar un cliente, una oferta o un pedido en Sibema. Pídeme el nombre o la referencia antes de buscar." },
      { id: "trinalum-documents", label: "Trabajar con un documento", prompt: "Voy a subir un documento. Resume sus datos y dime qué falta; no cambies ningún sistema sin mostrarme antes la acción." },
    ]);
  });

  it.each([undefined, "other", "g03", "bgreenly", "northwind-qa", "insijets-demo-other", "modtime-preview"])("gives installation %s neutral editable tasks without borrowing another client's workflow", (installationId) => {
    for (const companyName of ["Arnall", "InsiJets", "MODTIME", "Trinalum", "Example"]) {
      const suggestions = landingSuggestions(null, companyName, { installationId });
      expect(suggestions.map(item => item.id)).toEqual(["document-summary", "compare-options", "next-steps"]);
      expect(suggestions.every(item => item.prompt.includes(companyName) && !item.children && !item.iconPath)).toBe(true);
      expect(JSON.stringify(suggestions)).not.toMatch(/WhatsApp|horarios|Shopify|Meta ads|proveedores|vuelo privado/);
    }
  });

  it("preserves the existing MODTIME read-only commerce prompts", () => {
    const suggestions = landingSuggestions(null, "Renamed display brand", { installationId: "modtime" });
    expect(suggestions.map(item => item.label)).toEqual(["How is my store performing?", "Let’s review my Meta ads.", "Let’s review my Shopify orders."]);
    expect(suggestions.every(item => item.prompt.length > 100 && !item.children)).toBe(true);
    expect(suggestions[0].prompt).toContain("boundaries differ");
    expect(suggestions[1].prompt).toContain("platform-attributed");
    expect(suggestions[2].prompt).toContain("UTC");
  });

  it.each([...knownInstallations, "other"])("keeps image mode as the override for %s", (installationId) => {
    const suggestions = landingSuggestions(null, "Example", { installationId, imageGeneration: true }, english);
    expect(suggestions.map(item => item.id)).toEqual(["presentation-image", "illustration", "diagram"]);
    expect(suggestions[0].label).toBe("For a presentation");
    expect(suggestions.every(item => !item.children && !item.prompt.includes("Example"))).toBe(true);
  });

  it.each(["insijets-demo", "trinalum-production", "unknown"])("localizes every new label and editable prompt for %s while preserving inserted company content", (installationId) => {
    const companyName = "Empresa Proyecto {company}";
    const spanishSuggestions = landingSuggestions(null, companyName, { installationId });
    const englishSuggestions = landingSuggestions(null, companyName, { installationId }, english);
    englishSuggestions.forEach((item, index) => {
      expect(item.label).not.toBe(spanishSuggestions[index].label);
      expect(item.prompt).not.toBe(spanishSuggestions[index].prompt);
      expect(item.prompt.length).toBeGreaterThan(0);
      if (installationId === "unknown") expect(item.prompt).toContain(companyName);
    });
  });
});

it.each(['g03-production', 'g03-qa', 'g03-development'])('uses neutral tasks without inferring employee departments from installation %s', installationId => {
  const suggestions = landingSuggestions(null, 'G03', { installationId });
  expect(suggestions.map(item => item.id)).toEqual(['document-summary', 'compare-options', 'next-steps']);
  expect(suggestions.every(item => !item.children && !item.action)).toBe(true);
  expect(JSON.stringify(suggestions)).not.toMatch(/Rafa|Qualitat|Producció|Administració|SAGE/);
});
