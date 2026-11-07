import { expect, test } from "@playwright/test";

const accountName = process.env.AIBRAIN_UI_INSTALLATION === "northwind-qa" ? "Taylor" : "Alex";
const projectId = "018f5f68-4a6e-7abc-8def-0123456789ab";
const documentId = "018f5f68-4a6e-7abc-8def-0123456789ae";
const browserId = "018f5f68-4a6e-7abc-8def-0123456789af";
const imageId = "018f5f68-4a6e-7abc-8def-0123456789aa";

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

test("document preview, publication and historical browser artifacts remain readable", async ({ page }) => {
  const processing = {
    id: documentId,
    type: "document",
    name: "informe-sintetico.pdf",
    url: `/api/projects/${projectId}/artifacts/${documentId}`,
    kind: "pdf",
    mimeType: "application/pdf",
    size: 42_000,
    status: "processing",
    pages: null,
    previewUrl: null,
    publicationStatus: null,
    publicationError: null,
    targetLabel: null,
    error: null,
  };
  const events = [
    { type: "artifact", item: processing },
    { type: "artifact", item: { ...processing, status: "ready", pages: 2, previewUrl: `/api/projects/${projectId}/artifacts/${documentId}/preview/1`, publicationStatus: "awaiting_confirmation", targetLabel: "Informes/informe-sintetico.pdf" } },
    { type: "artifact", item: { id: imageId, type: "image", name: "imagen-sintetica.png", url: `/api/projects/${projectId}/artifacts/${imageId}`, prompt: "Un diagrama sintético sin datos privados" } },
    { type: "artifact", item: { id: browserId, type: "browser", name: "Comprobación web sintética", status: "active", control: "agent", viewerUrl: `/api/browser/sessions/${browserId}/viewer`, captureUrl: null, downloadUrl: `/api/browser/sessions/${browserId}/download`, error: null } },
    { type: "delta", value: "## Archivos preparados\n\nRevisa las vistas previas antes de continuar." },
    { type: "done" },
  ];
  await page.route("**/api/chat", (route) => route.fulfill({ status: 200, headers: { "Content-Type": "application/x-ndjson" }, body: `${events.map((event) => JSON.stringify(event)).join("\n")}\n` }));
  await page.route(`**/api/projects/${projectId}/artifacts/${documentId}/preview/1`, (route) => route.fulfill({
    status: 200,
    contentType: "application/pdf",
    body: validPdf(),
  }));
  await page.route(`**/api/projects/${projectId}/artifacts/${imageId}`, (route) => route.fulfill({
    status: 200,
    contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="720"><rect width="100%" height="100%" fill="#e9edff"/><circle cx="360" cy="310" r="150" fill="#315fe8"/><text x="360" y="550" text-anchor="middle" font-family="Arial" font-size="34" fill="#252522">Imagen sintética</text></svg>',
  }));

  await page.goto("/login");
  await page.getByRole("button", { name: new RegExp(accountName) }).click();
  await page.getByRole("textbox", { name: "Mensaje" }).fill("Prepara un PDF y una comprobación web sintéticos.");
  await page.getByRole("button", { name: "Enviar mensaje" }).click();

  await expect(page.getByRole("heading", { name: "Archivos preparados" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "informe-sintetico.pdf" })).toHaveCount(1);
  await page.getByRole("button", { name: "Revisar antes de descargar" }).click();
  await expect(page.getByRole("complementary", { name: "Vista previa de informe-sintetico.pdf" })).toBeVisible();
  await expect(page.getByTitle("Documento informe-sintetico.pdf")).toHaveAttribute("src", /^blob:/);
  await expect(page.getByText("Pendiente de confirmación segura")).toBeVisible();
  await expect(page.getByRole("img", { name: "Un diagrama sintético sin datos privados" })).toBeVisible();
  await expect(page.getByText("Registro histórico", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reabrir Comprobación web sintética" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Descargar resultado" })).toHaveCount(0);
  await expect(page.locator(`iframe[src="/api/browser/sessions/${browserId}/viewer"]`)).toHaveCount(0);
  await page.getByRole("button", { name: "Cerrar vista previa" }).click();
  await page.getByRole("button", { name: new RegExp(`${accountName}.*Abrir menú de cuenta`) }).click();
  await page.getByRole("menu", { name: "Cuenta y preferencias" }).getByRole("menuitem", { name: "Cerrar sesión" }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.locator("iframe")).toHaveCount(0);
});
