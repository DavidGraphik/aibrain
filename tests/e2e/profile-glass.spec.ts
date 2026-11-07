import { test, expect } from "@playwright/test";

for (const mobile of [false, true]) {
  test(`profile glass keeps account identity usable ${mobile ? "mobile" : "desktop"}`, async ({ page }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/login");
    await page.getByRole("button", { name: /Alex/ }).click();
    await expect(page.getByTestId("composer")).toBeVisible();
    await page.goto("/");
    await expect(page.getByTestId("composer")).toBeVisible();
    if (mobile) await page.getByRole("button", { name: "Mostrar u ocultar la barra lateral" }).click();
    const card = page.getByRole("button", { name: /Alex.*Abrir menú de cuenta/ });
    const avatar = card.locator('[aria-hidden="true"]');
    await expect(avatar).toBeVisible();
    expect(await avatar.evaluate((element) => element.getBoundingClientRect().height)).toBe(32);
    expect(await card.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    expect(await card.evaluate((element) => getComputedStyle(element).backdropFilter)).toBe("none");
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => document.documentElement.setAttribute("data-theme", theme), theme);
      await expect(page.getByTestId("sidebar-wave")).toHaveCount(0);
      await page.getByTestId("workbench-sidebar").screenshot({ path: `.impeccable/review/profile-glass-${mobile ? "mobile" : "desktop"}-${theme}.png` });
    }
    await card.click();
    await expect(page.getByRole("menu", { name: "Cuenta y preferencias" })).toBeVisible();
    if (mobile) {
      await card.click();
      await expect(card).toHaveAttribute("aria-expanded", "false");
    } else {
      await page.getByRole("menuitem", { name: "Configuración", exact: true }).focus();
      await page.keyboard.press("Escape");
      await expect(card).toBeFocused();
    }
    await page.emulateMedia({ forcedColors: "active" });
    expect(await card.evaluate((element) => getComputedStyle(element).backdropFilter)).toBe("none");
  });
}
