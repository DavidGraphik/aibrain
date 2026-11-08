import { test, expect } from "@playwright/test";

// First navigation may compile the workbench when using the local dev server.
test.setTimeout(60_000);

for (const [name, width, height] of [["desktop", 1440, 900], ["mobile", 390, 844], ["narrow", 320, 740]] as const) {
  test(`composer templates replace the draft without obsolete navigation on ${name}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/login");
    await page.getByRole("button", { name: /Alex/ }).click();
    await page.waitForURL(/\/$/);
    const composer = page.getByRole("textbox", { name: "Mensaje", exact: true });
    await expect(composer).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("navigation", { name: "Espais de treball" })).toHaveCount(0);
    await composer.fill("Texto anterior que debe desaparecer.");
    await page.getByRole("button", { name: "Añadir al mensaje", exact: true }).click();
    const menu = page.getByRole("menu", { name: "Añadir al mensaje", exact: true });
    await expect(menu.getByRole("menuitem", { name: "Archivos del servidor", exact: true })).toBeEnabled();
    await expect(menu.getByRole("menuitem", { name: "Conexiones", exact: true })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Tareas recurrentes", exact: true })).toHaveCount(0);
    await expect(menu.getByRole("menuitem", { name: "Adjuntar archivos", exact: true })).toBeFocused();
    await page.keyboard.press("End");
    await expect(menu.getByRole("menuitem", { name: "Archivos del servidor", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Añadir al mensaje", exact: true })).toBeFocused();
    // The generic Example fixture must never expose Arnall's schedule templates.
    await expect(page.getByRole("button", { name: /Trabajemos en los horarios/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Comparar opciones", exact: true }).click();
    await expect(composer).toHaveValue(/^Comparemos estas opciones para Example Laboratory/);
    await expect(composer).not.toHaveValue("Texto anterior que debe desaparecer.");
    await expect(composer).toBeFocused();
    await expect(menu).toHaveCount(0);
    await expect(page.getByRole("menu", { name: "Horarios del equipo", exact: true })).toHaveCount(0);
    expect(await page.locator("body").evaluate(el => el.scrollWidth)).toBeLessThanOrEqual(width);
  });
}
