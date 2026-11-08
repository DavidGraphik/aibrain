import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const accountName = process.env.AIBRAIN_UI_INSTALLATION === "northwind-qa" ? "Taylor" : "Alex";
const projectId = "018f5f68-4a6e-7abc-8def-0123456789ab";
const documentId = "018f5f68-4a6e-7abc-8def-0123456789ae";

test("document preview and browser session states have no blocking axe violations", async ({ page }) => {
  const events = [
    { type: "artifact", item: { id: documentId, type: "document", name: "informe-sintetico.pdf", url: `/api/projects/${projectId}/artifacts/${documentId}`, kind: "pdf", mimeType: "application/pdf", size: 42_000, status: "ready", pages: 2, previewUrl: `/api/projects/${projectId}/artifacts/${documentId}/preview/1`, publicationStatus: "awaiting_confirmation", publicationError: null, targetLabel: "Informes/informe-sintetico.pdf", error: null } },
    { type: "artifact", item: { id: "018f5f68-4a6e-7abc-8def-0123456789af", type: "browser", name: "Comprobación web sintética", status: "disconnected", control: null, viewerUrl: null, captureUrl: null, downloadUrl: null, error: null } },
    { type: "delta", value: "## Archivos preparados" },
    { type: "done" },
  ];
  await page.route("**/api/chat", (route) => route.fulfill({ status: 200, headers: { "Content-Type": "application/x-ndjson" }, body: `${events.map((event) => JSON.stringify(event)).join("\n")}\n` }));
  await page.route(`**/api/projects/${projectId}/artifacts/${documentId}/preview/1`, (route) => route.fulfill({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="100%" height="100%" fill="white"/><text x="80" y="120" font-family="Arial" font-size="32" fill="#252522">Informe sintetico</text></svg>' }));
  await page.goto("/login");
  await page.getByRole("button", { name: new RegExp(accountName) }).click();
  await page.getByRole("textbox", { name: "Mensaje" }).fill("Prepara capacidades sintéticas.");
  await page.getByRole("button", { name: "Enviar mensaje" }).click();
  await expect(page.getByRole("heading", { name: "informe-sintetico.pdf" })).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter((violation) =>
    violation.impact === "critical" || violation.impact === "serious",
  )).toEqual([]);
});
