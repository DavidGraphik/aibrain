import { expect, test, type Page } from "@playwright/test";

const accountName = process.env.AIBRAIN_UI_INSTALLATION === "northwind-qa" ? "Taylor" : "Alex";

async function openSettings(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: new RegExp(accountName) }).click();
  await expect(page.getByTestId("composer")).toBeVisible();
  await page.getByRole("button", { name: /Abrir menú de cuenta/ }).click();
  await page.getByRole("menuitem", { name: "Configuración" }).click();
  await expect(page.getByRole("dialog", { name: /Configuración de/ })).toBeVisible();
}

test("higher contrast removes blur and makes floating chrome opaque", async ({ page }) => {
  await page.emulateMedia({ contrast: "more" });
  await openSettings(page);

  const material = await page.locator(".workspace-overlay").evaluate((element) => {
    const overlay = getComputedStyle(element);
    const header = getComputedStyle(element.querySelector(".workspace-panel-header") as HTMLElement);
    return {
      backdropFilter: overlay.backdropFilter,
      headerBackground: header.backgroundColor,
    };
  });

  expect(material.backdropFilter).toBe("none");
  expect(material.headerBackground).not.toMatch(/rgba?\([^)]*,\s*0\s*\)$/);
});

test("forced colors retains explicit workbench boundaries", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active" });
  await openSettings(page);

  expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
  const panel = page.getByRole("dialog", { name: /Configuración de/ });
  await expect(panel).toHaveCSS("border-left-style", "solid");
  await expect(panel).toHaveCSS("color", "rgb(0, 0, 0)");
});
