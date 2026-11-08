import { expect, test, type Page } from "@playwright/test";
import { establishDemoSession, submitPrompt } from "../helpers/playwright-auth";

const demoUserId = process.env.AIBRAIN_UI_INSTALLATION === "northwind-qa" ? "operations-user" : "example-user";
const accountName = demoUserId === "operations-user" ? "Taylor" : "Alex";
const primaryProject = demoUserId === "operations-user" ? "Operacions" : "Espacio principal";

test.setTimeout(120_000);

async function login(page: Page) {
  await establishDemoSession(page, demoUserId);
  await openMobileDrawerIfNeeded(page);
  await expect(page.getByRole("button", { name: "Automatizaciones", exact: true })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Nueva conversación", exact: true }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: /¿(?:En qué te puedo ayudar, .+|Cómo puedo ayudarte en .+)\?/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Biblioteca", exact: true })).toHaveCount(0);
  await expect(page.getByText("Conectando con el servicio…")).toHaveCount(0, { timeout: 60_000 });
  await page.locator("nextjs-portal").evaluateAll((nodes) => nodes.forEach((node) => node.remove()));
}

async function openMobileDrawerIfNeeded(page: Page) {
  if ((page.viewportSize()?.width ?? 1440) >= 768) return;
  await page.getByRole("button", { name: "Mostrar u ocultar la barra lateral" }).click();
  await expect(page.getByRole("dialog", { name: "Navegación" })).toBeVisible();
}

async function openSettings(page: Page) {
  await openMobileDrawerIfNeeded(page);
  await page.getByRole("button", { name: new RegExp(`${accountName}.*Abrir menú de cuenta`) }).click();
  await page.getByRole("menuitem", { name: "Configuración" }).click();
}

async function assertLandingComposer(page: Page) {
  const composer = page.getByTestId("composer");
  await expect(composer).toHaveAttribute("data-layout", "landing");
  await expect(composer).not.toHaveClass(/composer-compact/);
  await expect.poll(() => composer.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(116);
}

async function installAdministrationRoutes(page: Page) {
  const policy = {
    apps: { "web-search": true, "image-generation": true, skills: true, "managed-browser": true },
    capabilities: { consult: true, respond: true, execute: true, publish: true },
  };
  const role = {
    id: "workspace-owner", name: "Propietario", description: "Administra el espacio de trabajo.",
    canManageWorkspace: true, policy,
  };
  await page.route("**/api/settings", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      schemaVersion: 1,
      account: { userId: "example-user", displayName: "Alex Example", email: "alex@example.test", provider: "demo", expiresAt: "2099-01-01T00:00:00.000Z" },
      company: { installationId: "example-laboratory", name: "Example Laboratory", isAdmin: true },
      apps: [],
      connectors: [],
      memory: { enabled: true, confirmationRequired: false, scopes: ["private", "project", "company"], provenanceVisible: true, employeeRuntimeIsolated: true, sharedComputerHistory: false },
      notifications: { backgroundTurns: true, approvals: true, failures: true, sound: false },
      permissions: [],
      privacy: { conversationStorage: "company_private", providerTraining: "not_managed_here", employeeIsolation: true, memoryScope: "automatic_private_memory" },
      browser: { profileScope: "private_per_employee", networkPolicy: "public_http_https_only", privateNetworkAllowed: false, mutationsRequireApproval: true, downloadsArePrivate: true },
    }),
  }));
  await page.route("**/api/settings/team", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ members: [] }) }));
  await page.route("**/api/usage/me", (route) => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
  await page.route("**/api/usage/company", (route) => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
  await page.route("**/api/admin", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      schemaVersion: 1,
      installationId: "example-laboratory",
      companyName: "Example Laboratory",
      currentUserRoleId: "workspace-owner",
      identityProvisioning: { mode: "local-profile-only", emailDelivery: false, detail: "El alta se completa en el servidor de la empresa." },
      roles: [role],
      groups: [{
        id: "018f5f68-4a6e-7abc-8def-0123456789c1", name: "Operaciones", description: "Equipo de operaciones internas.",
        memberIds: ["018f5f68-4a6e-7abc-8def-0123456789c2"], policy,
        createdAt: "2026-08-20T09:00:00.000Z", updatedAt: "2026-08-27T09:00:00.000Z",
      }],
      members: [{
        userId: "018f5f68-4a6e-7abc-8def-0123456789c2", displayName: "Alex Example", email: "alex@example.test",
        enabled: true, workerId: "worker-alex", workerState: "running", workerHealthy: true,
        roleId: "workspace-owner", groupIds: ["018f5f68-4a6e-7abc-8def-0123456789c1"],
        usage: { turns: 18, inputTokens: "24500", outputTokens: "8200" },
      }],
      audit: [{
        schemaVersion: 1, installationId: "example-laboratory", actorUserId: "example-user",
        action: "group.updated", targetType: "group", targetId: "018f5f68-4a6e-7abc-8def-0123456789c1",
        summary: "Se revisaron los permisos del grupo Operaciones.", occurredAt: "2026-08-27T09:30:00.000Z", sequence: 1,
      }],
    }),
  }));
}

async function installCompletedTurnRoute(page: Page) {
  await page.route("**/api/chat", (route) => route.fulfill({
    status: 200,
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
    body: [
      { type: "plan", explanation: "Preparando un resumen claro", steps: [
        { step: "Entender el objetivo", status: "completed" },
        { step: "Revisar el contenido", status: "completed" },
        { step: "Preparar el resultado", status: "in_progress" },
      ] },
      { type: "activity", item: { id: "summary-ready", kind: "reasoning", label: "Contenido revisado", detail: "Se han identificado las ideas principales", status: "complete" } },
      { type: "delta", value: "## Vista previa\n\nHe preparado una respuesta sintética con las tres ideas más importantes.\n\n### Resumen\n\n- Objetivo identificado.\n- Información ordenada.\n- Próximos pasos listos para revisar." },
      { type: "done" },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
  }));
}

async function installPendingTurnRoute(page: Page) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/chat", async (route) => {
    await gate;
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
      body: `${JSON.stringify({ type: "done" })}\n`,
    });
  });
  return release;
}

test("employee shell light", async ({ page }) => {
  await login(page);
  await assertLandingComposer(page);
  await expect(page).toHaveScreenshot("employee-shell-light.png", { fullPage: true });
});

test("employee shell dark", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await login(page);
  await assertLandingComposer(page);
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim())).toBe("#000000");
  await expect(page).toHaveScreenshot("employee-shell-dark.png", { fullPage: true });
});

test("immediate activity light", async ({ page }) => {
  await login(page);
  const release = await installPendingTurnRoute(page);
  await submitPrompt(page, "Prepara una respuesta breve.");
  await expect(page.getByText(/^Enviando solicitud/u)).toBeVisible({ timeout: 1_000 });
  await expect(page).toHaveScreenshot("immediate-activity-light.png", { fullPage: true });
  release();
  await expect(page.getByRole("button", { name: "Detener respuesta" })).toHaveCount(0);
});

test("immediate activity dark", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await login(page);
  const release = await installPendingTurnRoute(page);
  await submitPrompt(page, "Prepara una respuesta breve.");
  await expect(page.getByText(/^Enviando solicitud/u)).toBeVisible({ timeout: 1_000 });
  await expect(page).toHaveScreenshot("immediate-activity-dark.png", { fullPage: true });
  release();
  await expect(page.getByRole("button", { name: "Detener respuesta" })).toHaveCount(0);
});

test("employee shell collapsed rail light", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "visual-desktop", "desktop-only sidebar state");
  await login(page);
  await page.getByRole("button", { name: "Ocultar barra lateral" }).click();
  const sidebar = page.getByTestId("workbench-sidebar");
  await expect(sidebar).toHaveAttribute("data-desktop-state", "collapsed");
  await expect.poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().width)).toBe(52);
  await expect(page).toHaveScreenshot("employee-shell-collapsed-rail-light.png", { fullPage: true });
});

test("preferences dark", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await login(page);
  await openSettings(page);
  const preferences = page.getByRole("dialog", { name: /Configuración de/ });
  await expect(preferences).toBeVisible();
  await preferences.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
  await expect(page).toHaveScreenshot("preferences-dark.png", { fullPage: true });
});

test("composer tools menu light", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "Añadir al mensaje" }).click();
  await expect(page.getByRole("menu", { name: "Añadir al mensaje" })).toBeVisible();
  await expect(page).toHaveScreenshot("composer-tools-menu-light.png", { fullPage: true });
});

test("composer mode menu light", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "Experiencia" }).click();
  await expect(page.getByRole("menu", { name: "Experiencia" })).toBeVisible();
  await expect(page).toHaveScreenshot("composer-mode-menu-light.png", { fullPage: true });
});

test("account menu light", async ({ page }) => {
  await login(page);
  await openMobileDrawerIfNeeded(page);
  await page.getByRole("button", { name: new RegExp(`${accountName}.*Abrir menú de cuenta`) }).click();
  await expect(page.getByRole("menu", { name: "Cuenta y preferencias" })).toBeVisible();
  await expect(page).toHaveScreenshot("account-menu-light.png", { fullPage: true });
});

test("command palette light", async ({ page }) => {
  await login(page);
  await page.keyboard.press("Meta+K");
  await expect(page.getByRole("dialog", { name: "Buscar proyectos y conversaciones" })).toBeVisible();
  await expect(page).toHaveScreenshot("command-palette-light.png", { fullPage: true });
});

test("automations occupy the main surface", async ({ page }) => {
  await login(page);
  await openMobileDrawerIfNeeded(page);
  await page.getByRole("button", { name: "Automatizaciones", exact: true }).click();
  const automations = page.getByRole("main", { name: "Automatizaciones" });
  const sidebar = page.getByTestId("workbench-sidebar");
  await expect(automations).toBeVisible();
  const isMobile = (page.viewportSize()?.width ?? 1440) < 768;
  if (isMobile) await expect(sidebar).toBeHidden();
  else await expect(sidebar).toBeVisible();
  await expect(page.getByText("Centro de tareas")).toHaveCount(0);
  await expect(page.getByText(/Servicio de automatizaciones|Se ejecutan mientras/i)).toHaveCount(0);
  await expect(page.getByText("Cargando automatizaciones…")).toBeHidden({ timeout: 60_000 });
  await automations.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
  const automationBounds = await automations.boundingBox();
  expect(automationBounds).not.toBeNull();
  if (isMobile) {
    expect(automationBounds!.x).toBeCloseTo(0, 0);
  } else {
    const sidebarBounds = await sidebar.boundingBox();
    expect(sidebarBounds).not.toBeNull();
    expect(automationBounds!.x).toBeGreaterThanOrEqual(sidebarBounds!.x + sidebarBounds!.width - 1);
  }
  expect(automationBounds!.x + automationBounds!.width).toBeCloseTo(page.viewportSize()?.width ?? 1440, 0);
  expect(automationBounds!.width).toBeGreaterThan((page.viewportSize()?.width ?? 1440) * 0.7);
  await expect(page).toHaveScreenshot("scheduled-work-surface-light.png", { fullPage: true });
});

test("project actions surface light", async ({ page }) => {
  await login(page);
  await openMobileDrawerIfNeeded(page);
  const project = page.getByRole("button", { name: primaryProject, exact: true });
  await project.hover({ position: { x: 20, y: 20 } });
  await page.getByRole("button", { name: `Acciones de ${primaryProject}` }).click();
  await expect(page.getByRole("menuitem", { name: "Renombrar" })).toBeVisible();
  await expect(page).toHaveScreenshot("project-actions-surface-light.png", { fullPage: true });
});

test("employee settings omit administration entry point dark", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await installAdministrationRoutes(page);
  await login(page);
  await openSettings(page);
  await expect(page.getByRole("link", { name: "Administración" })).toHaveCount(0);
  await expect(page.getByText(/políticas de empresa/i)).toHaveCount(0);
  await expect(page).toHaveScreenshot("administration-entry-point-dark.png", { fullPage: true });
});

test("create project dialog light", async ({ page }) => {
  await login(page);
  await openMobileDrawerIfNeeded(page);
  await page.getByRole("button", { name: "Crear proyecto" }).click();
  await expect(page.getByRole("dialog", { name: "Nuevo proyecto" })).toBeVisible();
  await expect(page).toHaveScreenshot("create-project-dialog-light.png", { fullPage: true });
});

test("employee shell mobile drawer", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "visual-mobile", "mobile-only interaction");
  await login(page);
  await page.getByRole("button", { name: "Mostrar u ocultar la barra lateral" }).click();
  await expect(page.getByTestId("workbench-sidebar")).toBeVisible();
  await assertLandingComposer(page);
  await expect(page).toHaveScreenshot("employee-shell-mobile-drawer.png", { fullPage: true });
});

test("completed conversation", async ({ page }, testInfo) => {
  await installCompletedTurnRoute(page);
  await login(page);
  await submitPrompt(page, "Resume este contenido sintético en tres ideas claras.");
  await expect(page.getByRole("heading", { name: "Vista previa" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Detener respuesta" })).toHaveCount(0, { timeout: 10_000 });
  await page.locator("nextjs-portal").evaluateAll((nodes) => nodes.forEach((node) => node.remove()));
  const scroller = page.locator(".workbench-main > .scrollbar-thin");
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(page.getByRole("button", { name: "Volver al final" })).toHaveCount(0);
  if (testInfo.project.name === "visual-mobile") {
    const composer = page.getByTestId("composer");
    await page.getByRole("textbox", { name: "Mensaje" }).evaluate((element) => (element as HTMLElement).blur());
    await expect(composer).toHaveAttribute("data-focused", "false");
    await expect(page.getByRole("button", { name: "Experiencia" })).toBeHidden();
  }
  await expect(page).toHaveScreenshot("completed-conversation.png", { fullPage: true });
  if (testInfo.project.name === "visual-mobile") {
    const composer = page.getByTestId("composer");
    await page.getByRole("textbox", { name: "Mensaje" }).focus();
    await expect(composer).toHaveAttribute("data-focused", "true");
    await expect(page.getByRole("button", { name: "Experiencia" })).toBeVisible();
    await expect.poll(() => composer.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(108);
    await expect(page).toHaveScreenshot("completed-conversation-mobile-focused.png", { fullPage: true });
  }
});

test("completed conversation dark", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await installCompletedTurnRoute(page);
  await login(page);
  await submitPrompt(page, "Resume este contenido sintético en tres ideas claras.");
  await expect(page.getByRole("heading", { name: "Vista previa" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Detener respuesta" })).toHaveCount(0, { timeout: 10_000 });
  await page.locator("nextjs-portal").evaluateAll((nodes) => nodes.forEach((node) => node.remove()));
  const scroller = page.locator(".workbench-main > .scrollbar-thin");
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(page).toHaveScreenshot("completed-conversation-dark.png", { fullPage: true });
});
