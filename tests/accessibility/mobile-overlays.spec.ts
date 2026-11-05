import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const accountName = process.env.AIBRAIN_UI_INSTALLATION === "northwind-qa" ? "Taylor" : "Alex";
const tenantId = process.env.AIBRAIN_UI_INSTALLATION === "northwind-qa" ? "operations" : "studio";
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

async function assertNoBlockingViolations(page: Page, surface: string, exclusions: string[] = []) {
  const builder = new AxeBuilder({ page });
  for (const selector of exclusions) builder.exclude(selector);
  const results = await builder.analyze();
  const blocking = results.violations.filter((violation) =>
    violation.impact === "critical" || violation.impact === "serious",
  );
  expect(
    blocking,
    `${surface}:\n${blocking.map((violation) => `${violation.id}: ${violation.help}`).join("\n")}`,
  ).toEqual([]);
}

test("mobile drawer, Review and PDF preview overlays have no blocking axe violations", async ({ page }) => {
  const events = [
    {
      type: "diff",
      value: "diff --git a/resultado.txt b/resultado.txt\n--- a/resultado.txt\n+++ b/resultado.txt\n@@ -1 +1 @@\n-Pendiente\n+Completado",
    },
    {
      type: "artifact",
      item: {
        id: documentId,
        type: "document",
        name: "informe-movil.pdf",
        url: `/api/projects/${projectId}/artifacts/${documentId}`,
        kind: "pdf",
        mimeType: "application/pdf",
        size: 42_000,
        status: "ready",
        pages: 1,
        previewUrl: `/api/projects/${projectId}/artifacts/${documentId}/preview/1`,
        publicationStatus: null,
        publicationError: null,
        targetLabel: null,
        error: null,
      },
    },
    { type: "delta", value: "## Resultado móvil\n\nEl turno está listo para revisión." },
    { type: "done" },
  ];
  await page.route("**/api/chat", (route) => route.fulfill({
    status: 200,
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
    body: `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  }));
  await page.route(`**/api/projects/${projectId}/artifacts/${documentId}/preview/1`, (route) => route.fulfill({
    status: 200,
    contentType: "application/pdf",
    body: validPdf(),
  }));
  await page.route("**/api/settings", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      schemaVersion: 1,
      account: { userId: "example-user", displayName: accountName, email: "user@example.test" },
      company: { installationId: "example-lab-playwright", name: "Example Laboratory", isAdmin: false },
      apps: [],
      connectors: [],
      memory: {
        enabled: true,
        confirmationRequired: false,
        scopes: ["private", "project", "company"],
        provenanceVisible: true,
        employeeRuntimeIsolated: true,
        sharedComputerHistory: false,
      },
      notifications: { backgroundTurns: true, approvals: true, failures: true, sound: false },
      permissions: [],
      privacy: {},
      browser: {},
    }),
  }));
  await page.goto("/login");
  await page.getByRole("button", { name: new RegExp(accountName) }).click();
  await expect(page.getByTestId("composer")).toBeVisible();
  expect(page.viewportSize()).toEqual({ width: 390, height: 844 });

  await page.getByRole("button", { name: "Mostrar u ocultar la barra lateral" }).click();
  const drawer = page.getByRole("dialog", { name: "Navegación" });
  await expect(drawer).toBeVisible();
  await assertNoBlockingViolations(page, "mobile drawer");
  await drawer.getByRole("button", { name: "Cerrar menú" }).click();

  await page.getByRole("textbox", { name: "Mensaje" }).fill("Prepara la revisión móvil sintética.");
  await page.getByRole("button", { name: "Enviar mensaje" }).click();
  await expect(page.getByRole("heading", { name: "Resultado móvil" })).toBeVisible();

  await page.getByRole("button", { name: "Abrir cambios y resultados" }).click();
  const review = page.getByRole("dialog", { name: "Cambios y resultados del turno" });
  await expect(review).toBeVisible();
  await assertNoBlockingViolations(page, "mobile Review overlay");
  await review.getByRole("button", { name: "Cerrar cambios y resultados" }).click();

  await page.getByRole("button", { name: "Revisar antes de descargar" }).click();
  const preview = page.getByRole("dialog", { name: "Vista previa de informe-movil.pdf" });
  await expect(preview).toBeVisible();
  await expect(page.getByTitle("Documento informe-movil.pdf")).toHaveAttribute("src", /^blob:/);
  await assertNoBlockingViolations(page, "mobile PDF preview overlay", [
    'iframe[title="Documento informe-movil.pdf"]',
  ]);
  await preview.getByRole("button", { name: "Cerrar vista previa" }).click();

  await expect(page.getByRole("dialog", { name: "Navegador" })).toHaveCount(0);
});

test("mobile viewer projects expose an accessible read-only history and context surface", async ({ page }) => {
  const now = "2026-08-30T09:00:00.000Z";
  const viewerProjectId = "018f5f68-4a6e-7abc-8def-0123456789b1";
  const viewerThreadId = "018f5f68-4a6e-7abc-8def-0123456789b2";
  await page.addInitScript(({ key, selectionKey, snapshot, selection }) => {
    localStorage.setItem(key, JSON.stringify(snapshot));
    localStorage.setItem(selectionKey, JSON.stringify(selection));
  }, {
    key: `aibrain.${tenantId}.${demoUserId}.workbench.preview.v1`,
    selectionKey: `aibrain.${tenantId}.${demoUserId}.selection.v1`,
    snapshot: {
      persistence: "browser-preview",
      projects: [{
        id: viewerProjectId,
        name: "Proyecto compartido",
        slug: "proyecto-compartido",
        status: "active",
        pinned: true,
        instructions: "Contexto de consulta para el equipo.",
        sources: [],
        memory: { enabled: true, notes: "Decisiones compartidas.", updatedAt: now },
        sharing: { visibility: "shared", members: [] },
        access: { role: "viewer", canEdit: false, canManage: false },
        workspace: {
          id: "018f5f68-4a6e-7abc-8def-0123456789b3",
          label: "Workspace compartido",
          hostType: "managed",
          status: "ready",
          isPrimary: true,
        },
        createdAt: now,
        updatedAt: now,
      }],
      threads: [{
        id: viewerThreadId,
        projectId: viewerProjectId,
        title: "Historial compartido",
        status: "active",
        pinned: true,
        createdAt: now,
        updatedAt: now,
        messages: [],
      }],
    },
    selection: {
      activeProjectId: viewerProjectId,
      threadByProject: { [viewerProjectId]: viewerThreadId },
    },
  });

  await page.goto("/login");
  await page.getByRole("button", { name: new RegExp(accountName) }).click();
  const main = page.getByRole("main");
  await expect(main).toHaveAttribute("aria-busy", "false");
  await expect(main).toHaveAttribute("data-read-only", "true");
  await expect(page.getByRole("status")).toContainText("Conversación de solo lectura");
  await expect(page.getByRole("textbox", { name: "Mensaje" })).toHaveCount(0);
  await assertNoBlockingViolations(page, "mobile viewer read-only history");

  await page.getByRole("button", { name: "Mostrar u ocultar la barra lateral" }).click();
  const drawer = page.getByRole("dialog", { name: "Navegación" });
  await drawer.getByRole("button", { name: "Acciones de Proyecto compartido" }).click();
  await page.getByRole("menuitem", { name: "Ajustes del proyecto" }).click();
  const context = page.getByRole("dialog", { name: "Configurar proyecto" });
  await expect(context).toContainText("Tienes acceso de solo lectura");
  await expect(context.getByRole("button", { name: "Guardar cambios" })).toHaveCount(0);
  await page.waitForTimeout(300);
  await assertNoBlockingViolations(page, "mobile viewer context overlay");
});
