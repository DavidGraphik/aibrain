import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { establishDemoSession, submitPrompt } from "../helpers/playwright-auth";

const demoUserId = process.env.AIBRAIN_UI_INSTALLATION === "northwind-qa" ? "operations-user" : "example-user";
const projectId = "018f5f68-4a6e-7abc-8def-0123456789ab";
const documentId = "018f5f68-4a6e-7abc-8def-0123456789ae";
const viewports = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 600, height: 900 },
  { width: 390, height: 844 },
  { width: 375, height: 812 },
  { width: 320, height: 568 },
  { width: 844, height: 390 },
];

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

const approvalEvents = [
  { type: "plan", explanation: "Matriz visual sintética", steps: [
    { step: "Inspeccionar el proyecto", status: "completed" },
    { step: "Preparar el resultado", status: "in_progress" },
  ] },
  { type: "activity", item: { id: "matrix-command", kind: "command", label: "Comprobar datos", detail: "Lectura sintética completada", output: "status: clean", status: "complete" } },
  { type: "diff", value: "diff --git a/estado.txt b/estado.txt\n--- a/estado.txt\n+++ b/estado.txt\n@@ -1 +1 @@\n-Pendiente\n+Completado" },
  { type: "approval", item: { id: "018f5f68-4a6e-7abc-8def-012345678931", threadId: "018f5f68-4a6e-7abc-8def-012345678932", turnId: "018f5f68-4a6e-7abc-8def-012345678933", itemId: "018f5f68-4a6e-7abc-8def-012345678934", kind: "command", title: "Ejecutar comprobación", detail: "Comprueba únicamente el estado sintético.", command: "check --synthetic", cwd: "/workspace/synthetic", status: "pending" } },
  { type: "delta", value: "## Resultado preparado\n\nEl turno sintético está listo para revisión." },
  { type: "done" },
];

const documentEvents = [
  { type: "artifact", item: {
    id: documentId, type: "document", name: "informe-sintetico.pdf",
    url: `/api/projects/${projectId}/artifacts/${documentId}`, kind: "pdf",
    mimeType: "application/pdf", size: 42_000, status: "ready", pages: 2,
    previewUrl: `/api/projects/${projectId}/artifacts/${documentId}/preview/1`,
    publicationStatus: "awaiting_confirmation", publicationError: null,
    targetLabel: "Informes/informe-sintetico.pdf", error: null,
  } },
  { type: "delta", value: "## Documento preparado\n\nLa vista previa está lista para revisión segura." },
  { type: "done" },
];

const turnEvents = [approvalEvents, documentEvents];

async function screenshot(page: Page, name: string, viewport: { width: number; height: number }) {
  await page.locator("nextjs-portal").evaluateAll((nodes) => nodes.forEach((node) => node.remove()));
  const horizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(horizontalOverflow, `${name} must not overflow horizontally`).toBeLessThanOrEqual(1);
  await expect(page).toHaveScreenshot(`${name}-${viewport.width}x${viewport.height}.png`, {
    animations: "allow",
    fullPage: true,
    maxDiffPixelRatio: 0.005,
  });
}

async function settleAtWorkbenchBottom(page: Page) {
  const scroller = page.locator("main.workbench-main > div.overflow-y-auto").first();
  await scroller.evaluate((element) => new Promise<void>((resolve) => {
    let stableFrames = 0;
    const observe = () => {
      element.scrollTop = element.scrollHeight;
      const bottomDistance = element.scrollHeight - element.clientHeight - element.scrollTop;
      stableFrames = Math.abs(bottomDistance) < 0.5 ? stableFrames + 1 : 0;
      if (stableFrames >= 12) resolve();
      else requestAnimationFrame(observe);
    };
    requestAnimationFrame(observe);
  }));
}

async function centerArtifactInWorkbench(page: Page, target: ReturnType<Page["locator"]>) {
  const scroller = page.locator("main.workbench-main > div.overflow-y-auto").first();
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await target.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest" }));
  await scroller.evaluate((element) => new Promise<void>((resolve) => {
    let previous = element.scrollTop;
    let stableFrames = 0;
    const observe = () => {
      const current = element.scrollTop;
      stableFrames = Math.abs(current - previous) < 0.5 ? stableFrames + 1 : 0;
      previous = current;
      if (stableFrames >= 12) resolve();
      else requestAnimationFrame(observe);
    };
    requestAnimationFrame(observe);
  }));
}

async function installRoutes(page: Page) {
  let turnIndex = 0;
  await page.route("**/api/chat", (route) => route.fulfill({
    status: 200,
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
    body: `${turnEvents[Math.min(turnIndex++, turnEvents.length - 1)].map((event) => JSON.stringify(event)).join("\n")}\n`,
  }));
  await page.route(`**/api/projects/${projectId}/artifacts/${documentId}/preview/1`, (route) => route.fulfill({
    status: 200,
    contentType: "application/pdf",
    body: validPdf(),
  }));

}

async function offlineCapture(page: Page, context: BrowserContext, viewport: { width: number; height: number }) {
  await context.setOffline(true);
  await expect(page.getByText("Sin conexión. El historial sigue disponible y no se enviará nada.")).toBeVisible();
  await screenshot(page, "shell-offline-light", viewport);
  await context.setOffline(false);
  await expect(page.getByText("Sin conexión")).toBeHidden();
}

for (const viewport of viewports) {
  test(`complete state matrix at ${viewport.width}x${viewport.height}`, async ({ page, context }) => {
    let approvalRequestCount = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/runtime/approvals")) approvalRequestCount += 1;
    });
    await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.addInitScript(() => localStorage.removeItem("aibrain:theme"));
    await installRoutes(page);

    await page.goto("/login");
    await screenshot(page, "login-light", viewport);
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await screenshot(page, "login-dark", viewport);

    await establishDemoSession(page, demoUserId);
    await screenshot(page, "shell-dark", viewport);

    if (viewport.width < 768) {
      await page.getByRole("button", { name: "Mostrar u ocultar la barra lateral" }).click();
      await expect(page.getByRole("dialog", { name: "Navegación" })).toBeVisible();
    }
    await page.getByRole("button", { name: /Abrir menú de cuenta/ }).click();
    await page.getByRole("menuitem", { name: "Configuración" }).click();
    const preferences = page.getByRole("dialog", { name: /Configuración de/ });
    await expect(preferences).toBeVisible();
    await preferences.evaluate(async (element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
    await screenshot(page, "preferences-dark", viewport);
    await page.keyboard.press("Escape");

    if (viewport.width < 768) {
      const mobileNavigation = page.getByRole("dialog", { name: "Navegación" });
      await expect(mobileNavigation).toBeVisible();
      await screenshot(page, "drawer-dark", viewport);
      await page.keyboard.press("Escape");
      await expect(mobileNavigation).toBeHidden();
    }

    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await offlineCapture(page, context, viewport);

    await submitPrompt(page, "Prepara la matriz visual sintética.");
    await expect(page.getByRole("heading", { name: "Resultado preparado" })).toBeVisible();
    const approval = page.getByRole("group", { name: "Aprobación: Ejecutar comprobación" });
    await settleAtWorkbenchBottom(page);
    await expect(approval).toBeInViewport();
    await screenshot(page, "turn-approval-light", viewport);

    await expect(page.getByRole("button", { name: "Revisar resultados" })).toHaveCount(0);
    expect(approvalRequestCount).toBe(0);

    await submitPrompt(page, "Prepara un documento sintético.");
    const document = page.getByRole("heading", { name: "informe-sintetico.pdf" }).first();
    await expect(document).toBeVisible();
    await page.getByRole("button", { name: "Revisar antes de descargar" }).click();
    const preview = page.locator('aside[aria-label="Vista previa de informe-sintetico.pdf"]');
    await expect(preview).toBeVisible();
    await expect(page.getByTitle("Documento informe-sintetico.pdf")).toHaveAttribute("src", /^blob:/);
    await centerArtifactInWorkbench(page, document);
    await expect(document).toBeInViewport();
    expect(approvalRequestCount).toBe(0);
    await page.waitForTimeout(250);
    await expect(page.getByText("Esta aprobación ya no está pendiente.")).toBeHidden({ timeout: 6_000 });
    await screenshot(page, "document-light", viewport);
    expect(approvalRequestCount).toBe(0);
    await page.getByRole("button", { name: "Cerrar vista previa" }).click();


  });
}
