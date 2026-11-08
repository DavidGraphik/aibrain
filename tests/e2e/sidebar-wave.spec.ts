import { test, expect, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: /Alex/ }).click();
  await expect(page.getByTestId("composer")).toBeVisible();
}

test("desktop sidebar keeps account navigation without the decorative gradient", async ({ page }) => {
  await login(page);
  await expect(page.getByTestId("sidebar-wave")).toHaveCount(0);
  await expect(page.getByTestId("workbench-sidebar").locator("canvas")).toHaveCount(0);
  await page.getByRole("button", { name: /Alex.*Abrir menú de cuenta/ }).click();
  await expect(page.getByRole("menu", { name: "Cuenta y preferencias" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: /Alex.*Abrir menú de cuenta/ })).toBeFocused();
});

test("mobile drawer stays functional without WebGL decoration", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByRole("button", { name: "Mostrar u ocultar la barra lateral" }).click();
  await expect(page.getByTestId("workbench-sidebar")).toBeVisible();
  await expect(page.getByTestId("sidebar-wave").locator("canvas")).toHaveCount(0);
  await page.screenshot({ path: ".impeccable/review/sidebar-wave-mobile.png" });
  await page.getByRole("button", { name: /Alex.*Abrir menú de cuenta/ }).click();
  await expect(page.getByRole("menu", { name: "Cuenta y preferencias" })).toBeVisible();
});

test("project selection stays within its header when conversations are expanded", async ({ page }) => {
  await login(page);
  const row = page.getByTestId("sidebar-project-row").first();
  await row.click();
  const menu = page.locator('#projects-list');
  const highlight = menu.locator('.bg-active');
  await expect(highlight).toHaveCount(1);
  await expect.poll(async () => {
    const buttonBox = await row.boundingBox();
    const highlightBox = await highlight.boundingBox();
    if (!buttonBox || !highlightBox) return 999;
    return Math.max(Math.abs(highlightBox.height - buttonBox.height), Math.abs(highlightBox.y - buttonBox.y));
  }).toBeLessThanOrEqual(1);
});
