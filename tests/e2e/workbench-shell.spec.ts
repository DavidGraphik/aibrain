import { loginDemoEmployee } from "../helpers/demo-login";
import { expect, test, type Locator, type Page } from "@playwright/test";

const northwind = process.env.AIBRAIN_UI_INSTALLATION === "northwind-qa";
const accountName = northwind ? "Taylor" : "Alex";
const productName = northwind ? "Northwind AI" : "Example AI";
const primaryProject = northwind ? "Operacions" : "Espacio principal";

async function login(page: Page) {
  await loginDemoEmployee(page, accountName);
}

async function contentStartX(locator: Locator) {
  return locator.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.x + Number.parseFloat(getComputedStyle(element).paddingLeft || "0");
  });
}

async function expectSidebarContentGuide(page: Page) {
  const expand = page.getByTestId("sidebar-project-header").first().getByRole("button", { name: /^Expandir / });
  if (await expand.count()) await expand.click();
  await expect(page.getByTestId("sidebar-project-thread").first()).toBeVisible();
  const guide = await contentStartX(page.getByTestId("sidebar-brand"));
  const rows = [
    page.getByRole("navigation", { name: "Navegación principal" }).getByRole("button", { name: "Nueva conversación" }),
    page.getByTestId("sidebar-chats-label"),
    page.getByTestId("sidebar-projects-label"),
  ];
  for (const row of rows) await expect.poll(() => contentStartX(row)).toBeCloseTo(guide, 0);
  await expect.poll(() => contentStartX(page.getByTestId("sidebar-project-row").first())).toBeGreaterThan(guide + 16);
  await expect.poll(() => contentStartX(page.getByTestId("sidebar-project-thread").first())).toBeGreaterThan(guide + 16);
  const projects = await page.getByTestId("sidebar-projects-label").boundingBox();
  const recents = await page.getByTestId("sidebar-chats-label").boundingBox();
  expect(projects!.y).toBeLessThan(recents!.y);
}

test("the employee shell exposes work, not implementation details", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await login(page);

  await expect(page.getByRole("img", { name: new RegExp(productName) })).toBeVisible();
  await expect(page.getByTestId("workbench-sidebar")).toBeVisible();
  await expect(page.getByTestId("composer")).toBeVisible();
  await expect(page.getByTestId("composer")).toHaveAttribute("data-layout", "landing");
  await expect(page.getByTestId("composer")).not.toHaveClass(/composer-compact/);
  await expect.poll(() => page.getByTestId("composer").evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(116);
  await expect(page.getByRole("button", { name: "Nueva conversación" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: primaryProject, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Automatizaciones" })).toBeVisible();
  await expect(page.getByLabel("Destino de la conversación")).toHaveText("Proyecto");
  await page.getByRole("button", { name: primaryProject, exact: true }).click();
  await expectSidebarContentGuide(page);
  await expect(page.getByRole("button", { name: "Biblioteca" })).toHaveCount(0);
  await expect(page.getByText("Centro de tareas", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Control plane|Supabase|Codex conectado|Runtime|tenant|owner|member/i)).toHaveCount(0);

  const projectButton = page.getByRole("button", { name: primaryProject, exact: true });
  await projectButton.hover({ position: { x: 80, y: 16 } });
  const projectActions = page.getByRole("button", { name: `Acciones de ${primaryProject}` });
  await projectActions.click();
  await expect(page.getByRole("menuitem", { name: "Renombrar" })).toBeVisible();
  await projectActions.click();

  await page.getByRole("button", { name: "Crear proyecto" }).click();
  await expect(page.getByRole("heading", { name: "Nuevo proyecto" })).toBeVisible();
  await page.getByRole("button", { name: "Cancelar" }).click();

  await expect(page.getByText("Trabajar", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Modo del turno" })).toHaveCount(0);
  await expect(page.getByLabel("Destino de la conversación")).toContainText(primaryProject);
  await expect(page.getByTestId("project-breadcrumb")).toContainText(primaryProject);
  await expect(page.getByRole("button", { name: /Abrir contexto/ })).toHaveCount(0);
  await expect(page.getByText("⌘K", { exact: true })).toHaveCount(0);

  const addMenuButton = page.getByRole("button", { name: "Añadir al mensaje" });
  await addMenuButton.click();
  const addMenu = page.getByRole("menu", { name: "Añadir al mensaje" });
  await expect(addMenu).toBeVisible();
  await expect(addMenu.getByRole("menuitemcheckbox", { name: /Buscar en la web/ })).toHaveCount(0);
  await expect(addMenu.getByRole("menuitemcheckbox", { name: "Crear imagen" })).toBeVisible();
  await expect(addMenu.getByRole("menuitem", { name: "Conexiones" })).toBeVisible();
  await expect(addMenu.getByText(/Buscar en la web|Acciones guiadas/i)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(addMenu).toBeHidden();

  const accountButton = page.getByRole("button", { name: new RegExp(`${accountName}.*Abrir menú de cuenta`) });
  await accountButton.click();
  const accountMenu = page.getByRole("menu", { name: "Cuenta y preferencias" });
  await expect(accountMenu).toBeVisible();
  await expect(accountMenu.getByRole("menuitem", { name: "Configuración" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(accountMenu).toBeHidden();
  await expect(accountButton).toBeFocused();

  await page.keyboard.press("Meta+K");
  const search = page.getByRole("dialog", { name: "Buscar proyectos y conversaciones" });
  await expect(search).toBeVisible();
  await search.getByRole("combobox").fill(primaryProject);
  await expect(search.getByRole("option", { name: `${primaryProject} Proyecto`, exact: true })).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  await expect(search).toBeHidden();

  const sidebar = page.getByTestId("workbench-sidebar");
  const sidebarWidth = () => sidebar.evaluate((element) => element.getBoundingClientRect().width);
  await page.getByRole("button", { name: "Ocultar barra lateral" }).click();
  // Do not require the runner to sample one particular animation frame. A
  // loaded browser may still report the starting width at 80 ms, while reduced
  // motion may go straight to the endpoint. The observable contract is that
  // the width leaves the expanded state and settles at the collapsed rail.
  await expect.poll(sidebarWidth).toBeLessThan(280);
  const rail = page.getByTestId("workbench-sidebar-rail");
  await expect(rail).toBeVisible();
  await expect(sidebar).toHaveAttribute("data-desktop-state", "collapsed");
  await expect.poll(sidebarWidth).toBe(52);
  await expect(rail.getByRole("button", { name: "Mostrar barra lateral" })).toBeFocused();
  await rail.getByRole("button", { name: "Mostrar barra lateral" }).click();
  await expect(sidebar).toHaveAttribute("data-desktop-state", "expanded");
  await expect.poll(sidebarWidth).toBe(280);
  await expect(page.getByRole("button", { name: "Ocultar barra lateral" })).toBeFocused();
  expect(pageErrors).toEqual([]);
});

test("project settings owns focus and restores the project action trigger", async ({ page }) => {
  await login(page);
  const project = page.getByRole("button", { name: primaryProject, exact: true });
  await project.hover();
  const projectActions = page.getByRole("button", { name: `Acciones de ${primaryProject}` });
  await projectActions.click();
  await page.getByRole("menuitem", { name: "Ajustes del proyecto" }).click();

  const dialog = page.getByRole("dialog", { name: "Configurar proyecto" });
  const close = dialog.getByRole("button", { name: "Cerrar" });
  const save = dialog.getByRole("button", { name: "Guardar cambios" });
  await expect(close).toBeFocused();

  await save.focus();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(save).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(projectActions).toBeFocused();
});

test("the mobile drawer opens and the composer remains available", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);

  await expect(page.getByTestId("composer")).toBeVisible();
  await page.getByRole("button", { name: "Mostrar u ocultar la barra lateral" }).click();
  await expect(page.getByTestId("workbench-sidebar")).toBeVisible();
  await expectSidebarContentGuide(page);
  const contextTrigger = page.locator('button[aria-label^="Acciones de"]').first();
  await contextTrigger.click();
  await expect(page.getByTestId("workbench-sidebar")).toHaveAttribute("data-context-menu-open", "true");
  await expect(page.locator('button[aria-label^="Acciones de"]:visible')).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Cerrar menú" })).toBeVisible();
  await page.getByRole("button", { name: "Automatizaciones", exact: true }).click();
  await expect(page.getByTestId("workbench-sidebar")).toBeHidden();
  await expect(page.getByRole("main", { name: "Automatizaciones" })).toBeVisible();
  await page.getByRole("main", { name: "Automatizaciones" }).getByRole("button", { name: "Mostrar u ocultar la barra lateral" }).click();
  await expect(page.getByTestId("workbench-sidebar")).toBeVisible();
  await page.getByRole("navigation", { name: "Navegación principal" }).getByRole("button", { name: "Nueva conversación" }).click();
  await expect(page.getByTestId("composer")).toBeVisible();
});

test("opens a new automation result absent from the initial sidebar", async ({ page }) => {
  await login(page);
  const snapshot = await (await page.request.get("/api/workbench")).json();
  const project = snapshot.workbench.projects[0];
  const threadId = "c9638d21-296b-4a5b-8c12-4796555a6441";
  const taskId = "d9638d21-296b-4a5b-8c12-4796555a6441";
  const timestamp = "2026-09-22T10:00:00.000Z";
  const thread = {
    id: threadId, projectId: project.id, title: "Resultado nuevo fuera de la barra lateral",
    status: "active", pinned: false, createdAt: timestamp, updatedAt: timestamp, messages: [],
  };
  await page.route(`**/api/threads/${threadId}`, (route) => route.fulfill({ json: { thread } }));
  await page.route(`**/api/projects/${project.id}`, (route) => route.fulfill({ json: { project } }));
  await page.route("**/api/automations", (route) => route.fulfill({ json: {
    schemaVersion: 1,
    audienceDirectory: { currentUserId: "owner", membershipPolicy: "current", users: [], groups: [] },
    tasks: [{
      id: taskId, name: "Prueba de resultado nuevo", prompt: "Solo lectura", projectId: project.id,
      projectName: project.name, state: "completed", timeZone: "Europe/Madrid",
      schedule: { kind: "once", runAt: timestamp }, nextRunAt: null, lastRunAt: timestamp,
      lastRunStatus: "succeeded", manualRun: null, lease: null,
      owner: { userId: "owner", name: accountName }, audience: { userIds: [], groupIds: [], membershipPolicy: "current" },
      access: { canManage: true, canViewResults: true },
    }],
  } }));
  await page.route(`**/api/automations/${taskId}/runs`, (route) => route.fulfill({ json: {
    schemaVersion: 1, runs: [{ runKey: "test-run", attempt: 1, status: "succeeded", threadId, startedAt: timestamp, finishedAt: timestamp }],
  } }));
  await page.getByRole("button", { name: "Automatizaciones", exact: true }).click();
  await page.getByRole("button", { name: "Historial y resultados" }).click();
  await page.getByRole("button", { name: "Abrir resultado" }).click();
  await expect(page.getByRole("heading", { name: thread.title, exact: true })).toBeVisible();
  await expect(page.getByTestId("composer")).toBeVisible();
});
