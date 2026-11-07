import { loginDemoEmployee } from "../helpers/demo-login";
import { test, expect } from "@playwright/test";

test("sidebar hover stays on its row and pauses while an action menu is open", async ({ page }) => {
  await loginDemoEmployee(page, process.env.AIBRAIN_UI_INSTALLATION === "northwind-qa" ? "Taylor" : "Alex");
  const sidebar = page.getByTestId("workbench-sidebar");
  const rows = page.getByTestId("sidebar-project-row");
  const hover = page.locator("#projects-list .bg-hover");
  // Neutral home no longer expands the first business project implicitly.
  const expand = sidebar.getByRole("button", { name: /^Expandir / }).first();
  await expand.click();
  await expect(page.getByTestId("sidebar-project-thread").first()).toBeVisible();
  await rows.first().hover();
  await expect(hover).toHaveCount(1);
  await expect.poll(async () => {
    const row = await rows.first().boundingBox();
    const highlight = await hover.boundingBox();
    return row && highlight ? Math.abs(row.y - highlight.y) : Infinity;
  }).toBeLessThanOrEqual(1);

  const actions = sidebar.locator(".sidebar-item-action");
  expect(await actions.count()).toBeGreaterThan(0);
  await expect.poll(() => actions.evaluateAll((nodes) => nodes.map((action) => ({
    label: action.getAttribute("aria-label"),
    action: action.getBoundingClientRect().height,
    row: action.parentElement!.getBoundingClientRect().height,
    top: Math.abs(action.getBoundingClientRect().top - action.parentElement!.getBoundingClientRect().top),
  })).filter(({ action, row, top }) => action > row || top > 1))).toEqual([]);

  // Expanded children belong to their own rows, never their project header.
  await page.getByTestId("sidebar-project-thread").first().hover();
  await expect(hover).toHaveCount(0);
  const trigger = sidebar.locator(".sidebar-item-action").first();
  await trigger.click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await rows.first().hover();
  await expect(hover).toHaveCount(0);
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("narrow sidebar actions retain a 44px target within their own row", async ({ page }) => {
  await loginDemoEmployee(page, process.env.AIBRAIN_UI_INSTALLATION === "northwind-qa" ? "Taylor" : "Alex");
  for (const width of [600, 390, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    if (!await page.getByRole("dialog", { name: "Navegación" }).isVisible()) {
      await page.getByRole("button", { name: "Mostrar u ocultar la barra lateral" }).click();
    }
    const actions = page.getByTestId("workbench-sidebar").locator(".sidebar-item-action");
    expect(await actions.count()).toBeGreaterThan(0);
    await expect.poll(() => actions.evaluateAll((nodes) => nodes.map((action) => ({
      label: action.getAttribute("aria-label"),
      action: action.getBoundingClientRect().height,
      width: action.getBoundingClientRect().width,
      row: action.parentElement!.getBoundingClientRect().height,
      top: Math.abs(action.getBoundingClientRect().top - action.parentElement!.getBoundingClientRect().top),
    })).filter(({ action, width, row, top }) => action < 44 || width < 44 || action > row || top > 1))).toEqual([]);
  }
});
