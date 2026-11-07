import { expect, test, type Page } from "@playwright/test";

const accountName = process.env.AIBRAIN_UI_INSTALLATION === "northwind-qa" ? "Taylor" : "Alex";
const projectId = "00000000-0000-4000-8000-000000000011";

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

async function login(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: new RegExp(accountName) }).click();
  await expect(page.getByTestId("composer")).toBeVisible();
}

test("a generated PDF can be reviewed beside the chat before it is downloaded", async ({ page }) => {
  const previewUrl = `/api/projects/${projectId}/files?path=informes%2Fprecios-carne.pdf&raw=1`;
  const downloadUrl = `${previewUrl}&download=1`;
  await page.route("**/api/chat", async (route) => {
    const events = [
      { type: "delta", value: "Informe creado y verificado: PDF A4 de 4 páginas." },
      { type: "artifact", item: {
        id: "00000000-0000-4000-8000-000000000099",
        type: "document",
        name: "precios-carne.pdf",
        url: downloadUrl,
        kind: "pdf",
        mimeType: "application/pdf",
        size: 4821,
        status: "ready",
        pages: 4,
        previewUrl,
        publicationStatus: null,
        publicationError: null,
        targetLabel: null,
        error: null,
      } },
      { type: "done" },
    ];
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
      body: `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    });
  });
  await page.route("**/api/projects/*/files?*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/pdf", body: validPdf() });
  });

  await login(page);
  await page.getByRole("textbox", { name: "Mensaje" }).fill("Genera el informe en PDF.");
  const chat = page.locator("main.workbench-main");
  const initialWidth = (await chat.boundingBox())?.width ?? 0;
  await page.getByRole("button", { name: "Enviar mensaje" }).click();

  await expect(page.getByRole("heading", { name: "precios-carne.pdf" })).toBeVisible();
  await page.getByRole("button", { name: "Revisar antes de descargar" }).click();
  const panel = page.getByRole("complementary", { name: "Vista previa de precios-carne.pdf" });
  await expect(panel).toBeVisible();
  await expect(page.getByTitle("Documento precios-carne.pdf")).toHaveAttribute("src", /^blob:/);
  await expect(panel.getByRole("link", { name: "Descargar precios-carne.pdf" })).toHaveAttribute("href", downloadUrl);
  expect((await chat.boundingBox())?.width ?? initialWidth).toBeLessThan(initialWidth);

  await page.getByRole("button", { name: "Cerrar vista previa" }).click();
  await expect(page.getByRole("complementary", { name: "Vista previa de precios-carne.pdf" })).toHaveCount(0);
});

test("a mobile PDF preview recovers from a private-route failure without leaving the panel loading", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const previewUrl = `/api/projects/${projectId}/files?path=informes%2Fmovil.pdf&raw=1`;
  let requests = 0;
  let servePdf = false;
  await page.route("**/api/chat", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
      body: `${JSON.stringify({ type: "artifact", item: {
        id: "00000000-0000-4000-8000-000000000098",
        type: "document",
        name: "movil.pdf",
        url: `${previewUrl}&download=1`,
        kind: "pdf",
        mimeType: "application/pdf",
        size: 4821,
        status: "ready",
        pages: 1,
        previewUrl,
        publicationStatus: null,
        publicationError: null,
        targetLabel: null,
        error: null,
      } })}\n${JSON.stringify({ type: "done" })}\n`,
    });
  });
  await page.route("**/api/projects/*/files?*", async (route) => {
    requests += 1;
    if (!servePdf) {
      await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"temporal"}' });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/pdf", body: validPdf() });
  });

  await login(page);
  await page.getByRole("textbox", { name: "Mensaje" }).fill("Genera el informe móvil.");
  await page.getByRole("button", { name: "Enviar mensaje" }).click();
  await page.getByRole("button", { name: "Revisar antes de descargar" }).click();

  const panel = page.getByRole("dialog", { name: "Vista previa de movil.pdf" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("alert")).toContainText("No se ha podido mostrar el PDF");
  await expect(panel.getByRole("status", { name: "Cargando vista previa del PDF" })).toHaveCount(0);
  servePdf = true;
  await panel.getByRole("button", { name: "Reintentar" }).click();
  await expect(page.getByTitle("Documento movil.pdf")).toHaveAttribute("src", /^blob:/);
  expect(requests).toBeGreaterThanOrEqual(2);
});
