import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const accountName = process.env.AIBRAIN_UI_INSTALLATION === "northwind-qa" ? "Taylor" : "Alex";
const projectId = "018f5f68-4a6e-7abc-8def-0123456789ab";
const documentId = "018f5f68-4a6e-7abc-8def-0123456789ae";

test("dark shell, composer tools and turn capabilities have no blocking axe violations", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  const events = [
    { type: "plan", explanation: null, steps: [{ step: "Revisar el proyecto", status: "completed" }] },
    { type: "activity", item: { id: "command-dark", kind: "command", label: "Comprobar proyecto", detail: "Lectura sintética terminada", output: "status: clean", status: "complete" } },
    { type: "diff", value: "diff --git a/resultado.txt b/resultado.txt\n--- a/resultado.txt\n+++ b/resultado.txt\n@@ -1 +1 @@\n-Pendiente\n+Completado" },
    { type: "approval", item: { id: "018f5f68-4a6e-7abc-8def-012345678911", threadId: "018f5f68-4a6e-7abc-8def-012345678912", turnId: "018f5f68-4a6e-7abc-8def-012345678913", itemId: "018f5f68-4a6e-7abc-8def-012345678914", kind: "command", title: "Ejecutar comprobación", detail: "Comprueba únicamente el estado sintético.", command: "check --synthetic", cwd: "/workspace/synthetic", status: "pending" } },
    { type: "artifact", item: { id: documentId, type: "document", name: "informe-sintetico.pdf", url: `/api/projects/${projectId}/artifacts/${documentId}`, kind: "pdf", mimeType: "application/pdf", size: 42_000, status: "ready", pages: 2, previewUrl: `/api/projects/${projectId}/artifacts/${documentId}/preview/1`, publicationStatus: "conflict", publicationError: null, targetLabel: "Informes/informe-sintetico.pdf", error: null } },
    { type: "artifact", item: { id: "018f5f68-4a6e-7abc-8def-0123456789af", type: "browser", name: "Comprobación web sintética", status: "reconnecting", control: "awaiting_approval", viewerUrl: null, captureUrl: null, downloadUrl: null, error: null } },
    { type: "delta", value: "## Resultado preparado\n\nEl turno está listo." },
    { type: "done" },
  ];
  await page.route("**/api/chat", (route) => route.fulfill({ status: 200, headers: { "Content-Type": "application/x-ndjson; charset=utf-8" }, body: `${events.map((event) => JSON.stringify(event)).join("\n")}\n` }));
  await page.route(`**/api/projects/${projectId}/artifacts/${documentId}/preview/1`, (route) => route.fulfill({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="100%" height="100%" fill="white"/><text x="80" y="120" font-family="Arial" font-size="32" fill="#252522">Informe sintetico</text></svg>' }));

  const assertNoBlockingViolations = async () => {
    await page.locator('[data-overlay-presence="present"]').evaluateAll(async (elements) => {
      const animations = elements.flatMap((element) => element.getAnimations({ subtree: true }));
      await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
    });
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious")).toEqual([]);
  };

  await page.goto("/login");
  await page.getByRole("button", { name: new RegExp(accountName) }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await assertNoBlockingViolations();

  await page.getByRole("button", { name: new RegExp(`${accountName}.*Abrir menú de cuenta`) }).click();
  await page.getByRole("menuitem", { name: "Configuración" }).click();
  await expect(page.getByRole("dialog", { name: /Configuración de/ })).toBeVisible();
  await assertNoBlockingViolations();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Añadir al mensaje" }).click();
  await expect(page.getByRole("menu", { name: "Añadir al mensaje" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Conexiones" })).toBeVisible();
  await assertNoBlockingViolations();
  await page.keyboard.press("Escape");

  await page.getByRole("textbox", { name: "Mensaje" }).fill("Ejecuta una comprobación sintética.");
  await page.getByRole("button", { name: "Enviar mensaje" }).click();
  await expect(page.getByRole("group", { name: "Aprobación: Ejecutar comprobación" })).toBeVisible();
  await assertNoBlockingViolations();
  await expect(page.getByRole("button", { name: "Revisar resultados" })).toHaveCount(0);
});
