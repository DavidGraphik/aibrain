import { expect, test, type Page } from "@playwright/test";
import { establishDemoSession, submitPrompt } from "../helpers/playwright-auth";

const demoUserId = process.env.AIBRAIN_UI_INSTALLATION === "northwind-qa" ? "operations-user" : "example-user";
const projectId = "018f5f68-4a6e-7abc-8def-0123456789ab";
const documentId = "018f5f68-4a6e-7abc-8def-0123456789ae";

function validPdf() {
  const header = "%PDF-1.4\n";
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n",
  ];
  const offsets: number[] = [];
  let offset = header.length;
  for (const object of objects) {
    offsets.push(offset);
    offset += object.length;
  }
  return `${header}${objects.join("")}xref\n0 4\n0000000000 65535 f \n${offsets.map((value) => `${String(value).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
}

async function openCapabilities(page: Page) {
  const document = {
    id: documentId, type: "document", name: "informe-sintetico.pdf",
    url: `/api/projects/${projectId}/artifacts/${documentId}`, kind: "pdf",
    mimeType: "application/pdf", size: 42_000, status: "ready", pages: 2,
    previewUrl: `/api/projects/${projectId}/artifacts/${documentId}/preview/1`,
    publicationStatus: "awaiting_confirmation", publicationError: null, targetLabel: "Informes/informe-sintetico.pdf", error: null,
  };
  const events = [
    { type: "artifact", item: document },
    { type: "delta", value: "## Archivos preparados\n\nRevisa las vistas previas antes de continuar." },
    { type: "done" },
  ];
  await page.route("**/api/chat", (route) => route.fulfill({ status: 200, headers: { "Content-Type": "application/x-ndjson" }, body: `${events.map((event) => JSON.stringify(event)).join("\n")}\n` }));
  await page.route(`**/api/projects/${projectId}/artifacts/${documentId}/preview/1`, (route) => route.fulfill({ status: 200, contentType: "application/pdf", body: validPdf() }));
  await establishDemoSession(page, demoUserId);
  await submitPrompt(page, "Prepara un PDF sintético.");
  await expect(page.getByRole("heading", { name: "Archivos preparados" })).toBeVisible();
  await page.locator("nextjs-portal").evaluateAll((nodes) => nodes.forEach((node) => node.remove()));
}

test("document preview and publication state", async ({ page }) => {
  await openCapabilities(page);
  const document = page.getByRole("heading", { name: "informe-sintetico.pdf" });
  await document.scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Revisar antes de descargar" }).click();
  await expect(page.getByRole("complementary", { name: "Vista previa de informe-sintetico.pdf" })).toBeVisible();
  await expect(page.getByTitle("Documento informe-sintetico.pdf")).toHaveAttribute("src", /^blob:/);
  await expect(page).toHaveScreenshot("document-preview.png", { fullPage: true });
  await page.getByRole("button", { name: "Cerrar vista previa" }).click();

});

test("document preview dark", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openCapabilities(page);
  const document = page.getByRole("heading", { name: "informe-sintetico.pdf" });
  await document.scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Revisar antes de descargar" }).click();
  await expect(page.getByRole("complementary", { name: "Vista previa de informe-sintetico.pdf" })).toBeVisible();
  await expect(page.getByTitle("Documento informe-sintetico.pdf")).toHaveAttribute("src", /^blob:/);
  await expect(page).toHaveScreenshot("document-preview-dark.png", { fullPage: true });
  await page.getByRole("button", { name: "Cerrar vista previa" }).click();

});
