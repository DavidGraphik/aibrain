import { test, expect } from "@playwright/test";

// First navigation may compile the workbench when using the local dev server.
test.setTimeout(60_000);

for (const width of [320, 390, 1440]) for (const theme of ["light", "dark"] as const) {
  test(`shared composer and task collision ${width} ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await page.emulateMedia({ colorScheme: theme });
    const response = await page.goto("/login");
    expect(response?.headers()["permissions-policy"]).toContain("microphone=(self)");
    await page.getByRole("button", { name: /Alex/ }).click();
    await page.waitForURL(/\/$/);
    const input = page.getByRole("textbox", { name: "Mensaje", exact: true });
    await expect(input).toBeVisible({ timeout: 30_000 });
    await expect(input).toBeFocused();
    // The composer uses the compact 14px scale at both breakpoints; retain the
    // separate 44px touch-target and overlap checks below.
    expect(await input.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBe(14);
    const band = page.getByLabel("Opciones para empezar"), composer = page.getByTestId("composer");
    const a = await band.boundingBox(), b = await composer.boundingBox();
    const bandInset = width >= 640 ? 14 : 0;
    expect(Math.abs(a!.x - b!.x - bandInset)).toBeLessThanOrEqual(1);
    expect(Math.abs(a!.width - (b!.width - 2 * bandInset))).toBeLessThanOrEqual(1);
    const controls = await band.locator('button[aria-label="Destino de la conversación"], button.landing-band-item').evaluateAll(nodes => nodes.map(n => { const r = n.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, height: r.height }; }));
    expect(controls.length).toBe(3);
    expect(Math.max(...controls.map(r => r.top)) - Math.min(...controls.map(r => r.top))).toBeLessThan(3);
    for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
      const first = controls[i], second = controls[j];
      const overlapsX = Math.min(first.right, second.right) - Math.max(first.left, second.left) > 1;
      const overlapsY = Math.min(first.top + first.height, second.top + second.height) - Math.max(first.top, second.top) > 1;
      expect(overlapsX && overlapsY).toBe(false);
    }
    for (const r of controls) { expect(r.left).toBeGreaterThanOrEqual(0); expect(r.right).toBeLessThanOrEqual(width); expect(r.height).toBeGreaterThanOrEqual(44); }
    await input.fill("Borrador que se reemplaza.");
    await expect(page.getByRole("button", { name: "Tareas recurrentes", exact: true })).toHaveCount(0);
    // This installation has generic templates, not another client's schedules.
    await expect(page.getByRole("button", { name: /Trabajemos en los horarios/ })).toHaveCount(0);
    const experience = page.getByRole("button", { name: "Experiencia", exact: true });
    await experience.click();
    const menu = page.getByRole("menu", { name: "Experiencia", exact: true });
    await expect(menu).toBeVisible();
    const r = await menu.boundingBox();
    expect(r!.x).toBeGreaterThanOrEqual(11); expect(r!.x + r!.width).toBeLessThanOrEqual(width - 11);
    expect(r!.y).toBeGreaterThanOrEqual(0);
    expect(r!.y + r!.height).toBeLessThanOrEqual(width === 1440 ? 900 : 844);
    await page.screenshot({ path: `.impeccable/review/connector-tasks-${width}-${theme}.png` });
    await expect(menu.getByRole("menuitemradio", { checked: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(experience).toBeFocused();
    await experience.press("ArrowDown");
    await expect(menu).toBeVisible();
    const child = await menu.boundingBox();
    expect(child!.x).toBeGreaterThanOrEqual(11); expect(child!.x + child!.width).toBeLessThanOrEqual(width - 11);
    await page.keyboard.press("End");
    await expect(menu.getByRole("menuitemradio").last()).toBeFocused();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Comparar opciones", exact: true }).click();
    await expect(input).toHaveValue(/^Comparemos estas opciones para Example Laboratory/);
    await expect(input).toBeFocused();
    await page.reload();
    await expect(input).toHaveValue(/^Comparemos estas opciones para Example Laboratory/);
    expect(await page.locator("body").evaluate(el => el.scrollWidth)).toBeLessThanOrEqual(width);
  });
}
