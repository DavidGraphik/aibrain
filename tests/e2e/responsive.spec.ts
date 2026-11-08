import { loginDemoEmployee } from "../helpers/demo-login";
import { expect, test, type Page } from "@playwright/test";

const accountName = process.env.AIBRAIN_UI_INSTALLATION === "northwind-qa" ? "Taylor" : "Alex";
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

async function login(page: Page) {
  await loginDemoEmployee(page, accountName);
}

for (const viewport of viewports) {
  test(`shell and dialogs stay inside ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await login(page);
    await page.locator("nextjs-portal").evaluateAll((nodes) => nodes.forEach((node) => node.remove()));
    if (viewport.width < 768) {
      await page.getByRole("button", { name: "Mostrar u ocultar la barra lateral" }).click();
      await expect(page.getByRole("dialog", { name: "Navegación" })).toBeVisible();
    }
    await page.getByRole("button", { name: "Nueva conversación", exact: true }).first().click();
    await expect(page.getByRole("heading", { level: 1, name: /¿(?:En qué te puedo ayudar, .+|Cómo puedo ayudarte en .+)\?/ })).toBeVisible();

    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    const composer = await page.getByTestId("composer").boundingBox();
    const emptyHeading = await page.getByRole("heading", { level: 1, name: /¿(?:En qué te puedo ayudar, .+|Cómo puedo ayudarte en .+)\?/ }).boundingBox();
    expect(composer).not.toBeNull();
    expect(emptyHeading).not.toBeNull();
    expect(composer!.x).toBeGreaterThanOrEqual(0);
    expect(composer!.x + composer!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(composer!.y - (emptyHeading!.y + emptyHeading!.height)).toBeGreaterThanOrEqual(16);

    if (viewport.width < 480) {
      await expect(page.locator(".composer-landing .composer-destination")).toBeHidden();
      const controlsStart = await page.locator('[data-testid="composer-controls"] .composer-controls-start').boundingBox();
      const controlsEnd = await page.locator('[data-testid="composer-controls"] .composer-controls-end').boundingBox();
      expect(controlsStart).not.toBeNull();
      expect(controlsEnd).not.toBeNull();
      expect(controlsStart!.x + controlsStart!.width).toBeLessThanOrEqual(controlsEnd!.x);
    }

    await page.getByRole("button", { name: "Añadir al mensaje" }).click();
    const addMenu = page.getByRole("menu", { name: "Añadir al mensaje" });
    await expect(addMenu.getByRole("menuitem", { name: "Conexiones" })).toBeVisible();
    const addMenuBox = await addMenu.boundingBox();
    expect(addMenuBox).not.toBeNull();
    expect(addMenuBox!.x).toBeGreaterThanOrEqual(0);
    expect(addMenuBox!.y).toBeGreaterThanOrEqual(0);
    expect(addMenuBox!.y + addMenuBox!.height).toBeLessThanOrEqual(viewport.height + 1);
    expect(addMenuBox!.x + addMenuBox!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Experiencia" }).click();
    const experienceMenu = await page.getByRole("menu", { name: "Experiencia" }).boundingBox();
    expect(experienceMenu).not.toBeNull();
    expect(experienceMenu!.x).toBeGreaterThanOrEqual(0);
    expect(experienceMenu!.y).toBeGreaterThanOrEqual(0);
    expect(experienceMenu!.y + experienceMenu!.height).toBeLessThanOrEqual(viewport.height + 1);
    expect(experienceMenu!.x + experienceMenu!.width).toBeLessThanOrEqual(viewport.width + 1);
    await page.keyboard.press("Escape");

    if (viewport.width < 768) {
      const header = await page.getByTestId("mobile-app-header").boundingBox();
      expect(header).not.toBeNull();
      expect(header!.x).toBeGreaterThanOrEqual(0);
      expect(header!.x + header!.width).toBeLessThanOrEqual(viewport.width + 1);

      await page.getByRole("button", { name: "Mostrar u ocultar la barra lateral" }).click();
      await expect(page.getByRole("dialog", { name: "Navegación" })).toBeVisible();

      const sidebarSearch = page.getByRole("button", { name: "Buscar" });
      await sidebarSearch.click();
      await expect(page.getByRole("dialog", { name: "Navegación" })).toBeHidden();
      await expect(page.getByRole("dialog", { name: "Buscar proyectos y conversaciones" })).toBeVisible();
      await expect(page.locator('[role="dialog"][aria-modal="true"]')).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: "Navegación" })).toBeVisible();
      await expect(sidebarSearch).toBeFocused();

      const sidebarAction = page.getByRole("button", { name: /Acciones de/ }).first();
      await expect(sidebarAction).toBeVisible();
      const sidebarActionTarget = await sidebarAction.boundingBox();
      expect(sidebarActionTarget).not.toBeNull();
      expect(sidebarActionTarget!.width).toBeGreaterThanOrEqual(44);
      expect(sidebarActionTarget!.height).toBeGreaterThanOrEqual(44);
    }
    const accountButton = page.getByRole("button", { name: new RegExp(`${accountName}.*Abrir menú de cuenta`) });
    await accountButton.click();
    await page.getByRole("menuitem", { name: "Configuración" }).click();
    const preferences = page.getByRole("dialog", { name: new RegExp("Configuración de") });
    await expect(preferences).toBeVisible();
    await preferences.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    const panel = await preferences.boundingBox();
    expect(panel).not.toBeNull();
    expect(panel!.x).toBeGreaterThanOrEqual(0);
    expect(panel!.x + panel!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(panel!.height).toBeLessThanOrEqual(viewport.height + 1);
    await page.keyboard.press("Escape");
    await expect(preferences).toBeHidden();

    if (viewport.width < 768) {
      const sidebarTrigger = page.getByRole("button", { name: "Mostrar u ocultar la barra lateral" });
      const restoredSidebar = page.getByRole("dialog", { name: "Navegación" });
      await expect(restoredSidebar).toBeVisible();
      await expect(page.locator('[aria-modal="true"]')).toHaveCount(1);
      await expect(accountButton).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(restoredSidebar).toBeHidden();
      await expect(sidebarTrigger).toBeFocused();
    }

    await page.getByRole("textbox", { name: "Mensaje" }).fill("Comprobar responsive");
    const send = page.getByRole("button", { name: "Enviar mensaje" });
    await expect(send).toBeEnabled();
    if (viewport.width <= 390) {
      const target = await send.boundingBox();
      expect(target).not.toBeNull();
      expect(target!.width).toBeGreaterThanOrEqual(44);
      expect(target!.height).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  });
}

test("mobile navigation closes when the viewport becomes desktop", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByRole("button", { name: "Mostrar u ocultar la barra lateral" }).click();
  await expect(page.getByRole("dialog", { name: "Navegación" })).toBeVisible();

  await page.setViewportSize({ width: 768, height: 844 });
  await expect(page.getByRole("dialog", { name: "Navegación" })).toBeHidden();
});

test("a pinned chat persists once across mobile and desktop sidebars", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByRole("button", { name: "Mostrar u ocultar la barra lateral" }).click();
  await page.getByTestId("sidebar-project-header").first().getByRole("button", { name: /^Acciones de / }).click();
  await page.getByRole("menuitem", { name: /^Nueva conversación en / }).click();
  await page.getByRole("textbox", { name: "Mensaje" }).fill("Conversación para fijar");
  await page.getByRole("button", { name: "Enviar mensaje" }).click();
  await page.getByRole("button", { name: "Mostrar u ocultar la barra lateral" }).click();
  const projectThread = page.locator('button[data-testid="sidebar-project-thread"]').first();
  await expect(projectThread).toBeVisible();
  const threadAction = projectThread.locator("xpath=..").getByRole("button", { name: /^Acciones de / });
  const actionLabel = await threadAction.getAttribute("aria-label");
  expect(actionLabel).toMatch(/^Acciones de .+/);
  const threadId = await projectThread.getAttribute("data-thread-id");
  expect(threadId).toMatch(/^[a-f0-9-]{36}$/);
  // Activity status contributes to the accessible name while the turn runs.
  // Identity remains stable across pinning, completion, reload and viewport changes.
  const byIdentity = `[data-thread-id="${threadId}"]`;

  await threadAction.click();
  await page.getByRole("menuitem", { name: "Fijar" }).click();
  const pinned = page.getByRole("region", { name: "Anclados" });
  await expect(pinned).toBeVisible();
  await expect(page.getByTestId("workbench-sidebar").locator(byIdentity)).toHaveCount(1);
  await expect(pinned.locator(byIdentity)).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: "Mostrar u ocultar la barra lateral" }).click();
  await expect(page.getByRole("region", { name: "Anclados" }).locator(byIdentity)).toBeVisible();
  await expect(page.getByTestId("workbench-sidebar").locator(byIdentity)).toHaveCount(1);

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByTestId("workbench-sidebar")).toHaveAttribute("data-desktop-state", "expanded");
  await expect(page.getByRole("region", { name: "Anclados" }).locator(byIdentity)).toBeVisible();
});

test("settings can recover after its initial request fails", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  let settingsRequests = 0;
  await page.route("**/api/settings", async (route) => {
    settingsRequests += 1;
    if (settingsRequests === 1) {
      await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      return;
    }
    await route.continue();
  });

  await page.getByRole("button", { name: "Mostrar u ocultar la barra lateral" }).click();
  await page.getByRole("button", { name: new RegExp(`${accountName}.*Abrir menú de cuenta`) }).click();
  await page.getByRole("menuitem", { name: "Configuración" }).click();
  await expect(page.getByRole("dialog", { name: "Navegación" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Reintentar" })).toBeVisible();

  await page.getByRole("button", { name: "Reintentar" }).click();
  await expect(page.getByRole("button", { name: "Reintentar" })).toBeHidden();
  await expect.poll(() => settingsRequests).toBe(2);
});
