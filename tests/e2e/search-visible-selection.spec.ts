import { expect, test } from "@playwright/test";
import { establishDemoSession } from "../helpers/playwright-auth";

for (const width of [390, 1440]) {
  test(`search keeps long-list keyboard selection visible at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await establishDemoSession(page, "example-user");
    await page.waitForFunction(() => Object.keys(localStorage).some((key) => key.endsWith(".workbench.preview.v1")));
    await page.evaluate(() => {
      const key = Object.keys(localStorage).find((key) => key.endsWith(".workbench.preview.v1"))!;
      const snapshot = JSON.parse(localStorage.getItem(key)!);
      const now = new Date().toISOString();
      snapshot.threads = Array.from({ length: 35 }, (_, index) => ({
        id: crypto.randomUUID(), projectId: snapshot.projects[0].id,
        title: `Resultado de auditoría ${String(index + 1).padStart(2, "0")}`,
        status: "active", pinned: false, createdAt: now, updatedAt: now, messages: [],
      }));
      localStorage.setItem(key, JSON.stringify(snapshot));
    });
    await page.reload();
    await expect(page.getByRole("main")).toHaveAttribute("aria-busy", "false");
    await page.keyboard.press("ControlOrMeta+k");
    const search = page.getByRole("combobox", { name: "Buscar proyectos y conversaciones" });
    await expect(search).toBeFocused();
    await search.fill("Resultado de auditoría");
    await expect(page.getByRole("option")).toHaveCount(35);
    const assertSelectedVisible = async () => {
      await expect.poll(() => page.locator('#command-palette-results [aria-selected="true"]').evaluate((option) => {
        const selected = option.getBoundingClientRect();
        const list = option.parentElement!.getBoundingClientRect();
        return selected.top >= list.top - 1 && selected.bottom <= list.bottom + 1;
      })).toBe(true);
      await expect(search).toBeFocused();
    };
    for (let index = 0; index < 34; index++) await search.press("ArrowDown");
    await expect(page.getByRole("option", { selected: true })).toContainText("35");
    await assertSelectedVisible();
    await search.press("ArrowDown");
    await expect(page.getByRole("option", { selected: true })).toContainText("01");
    await assertSelectedVisible();
    await search.press("ArrowUp");
    await expect(page.getByRole("option", { selected: true })).toContainText("35");
    await assertSelectedVisible();
    await search.fill("Resultado de auditoría 17");
    await expect(page.getByRole("option")).toHaveCount(1);
    await assertSelectedVisible();
    await search.press("Enter");
    await expect(page.getByRole("dialog", { name: "Buscar proyectos y conversaciones" })).toBeHidden();
  });
}
