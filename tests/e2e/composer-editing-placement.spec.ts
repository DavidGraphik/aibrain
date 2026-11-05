import { expect, test } from "@playwright/test";
import { establishDemoSession, enableRouteDrivenDemoWorkbench } from "../helpers/playwright-auth";

const mentions = [{ id: "gmail", label: "Gmail", kind: "connector", status: "connected", statusCode: null,
  canRead: true, requiresApprovalForWrites: true }];

for (const zoom of [1, 1.5]) for (const viewport of [{ width: 1440, height: 900 }, { width: 900, height: 520 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test(`schedule suggestions respect layout at ${viewport.width}x${viewport.height}, zoom ${zoom}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await establishDemoSession(page, "example-user");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: zoom });
    if (viewport.height <= 600) {
      // Compact-height layouts already hide suggestions to keep the composer usable.
      await expect(page.getByLabel("Sugerencias para empezar")).toBeHidden();
      await expect(page.getByRole("textbox", { name: "Mensaje", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Tareas recurrentes", exact: true })).toHaveCount(0);
      return;
    }
    const trigger = page.getByRole("button", { name: /Trabajemos en los horarios/ });
    if (zoom > 1) { await trigger.focus(); await trigger.press("Enter"); } else await trigger.click();
    const menu = page.getByRole("menu", { name: "Horarios del equipo", exact: true });
    const popup = page.locator("[data-connector-popover]");
    await expect(menu).toBeVisible();
    const assertAnchor = async () => {
      const a = await trigger.evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }), b = await popup.evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
      expect(a).not.toBeNull(); expect(b).not.toBeNull();
      const v = await page.evaluate(() => ({ x: visualViewport?.offsetLeft ?? 0, y: visualViewport?.offsetTop ?? 0, width: visualViewport?.width ?? innerWidth, height: visualViewport?.height ?? innerHeight }));
      const below = v.y + v.height - a!.y - a!.height - 16;
      if (below >= 64) expect(Math.abs(b!.y - (a!.y + a!.height + 6))).toBeLessThan(2);
      else expect(Math.abs(b!.y + b!.height - (a!.y - 6))).toBeLessThan(2);
      expect(b!.x).toBeGreaterThanOrEqual(v.x + 11);
      expect(b!.x + b!.width).toBeLessThanOrEqual(v.x + v.width - 11);
      expect(b!.y).toBeGreaterThanOrEqual(v.y);
      expect(b!.y + b!.height).toBeLessThanOrEqual(v.y + v.height);
    };
    await expect(assertAnchor).toPass({ timeout: 3_000 });
    await page.keyboard.press("End");
    await expect(menu.getByRole("menuitem", { name: "Revisar cambios de horarios", exact: true })).toBeFocused();
    await page.keyboard.press("Home");
    await expect(menu.getByRole("menuitem", { name: "Enviar los WhatsApps a los trabajadores", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  });
}

for (const width of [390, 1440]) {
  test(`tool text supports native editing and keeps tool selection in sync at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await enableRouteDrivenDemoWorkbench(page);
    await page.route("**/api/connectors/mentions", route => route.fulfill({ json: { mentions } }));
    await establishDemoSession(page, "example-user");
    const input = page.getByRole("textbox", { name: "Mensaje", exact: true });
    const selected = () => page.evaluate(() => {
      const key = Object.keys(localStorage).find(key => key.endsWith(".composer-drafts.v1.connectors"));
      return key ? Object.values(JSON.parse(localStorage.getItem(key)!)).flat() : [];
    });
    await input.fill("@Gm");
    await page.getByRole("option", { name: /Gmail/ }).click();
    await expect(input).toHaveValue("@Gmail ");
    await expect.poll(selected).toEqual(["gmail"]);
    await input.press("Backspace");
    await input.press("Backspace");
    await expect(input).toHaveValue("@Gmai");
    await expect(page.getByRole("listbox", { name: "Conectores disponibles" })).toHaveCount(0);
    await expect.poll(selected).toEqual([]);
    for (let i = 0; i < 5; i++) await input.press("ArrowLeft");
    await input.press("Delete");
    await expect(input).toHaveValue("Gmai");
    await input.fill("Use @Gmail now");
    await expect.poll(selected).toEqual(["gmail"]);
    await input.evaluate((element: HTMLTextAreaElement) => { element.focus(); element.setSelectionRange(4, 10); });
    await page.keyboard.insertText("plain text");
    await expect(input).toHaveValue("Use plain text now");
    await expect.poll(selected).toEqual([]);
    await input.press("ControlOrMeta+a");
    // insertText exercises the same native insertion path used by a mobile paste.
    await page.keyboard.insertText("@Gmail pasted");
    await expect.poll(selected).toEqual(["gmail"]);
    await input.press("End");
    for (let i = 0; i < 8; i++) await input.press("ArrowLeft");
    await input.press("Delete");
    await expect(input).toHaveValue("@Gmai pasted");
    await expect.poll(selected).toEqual([]);
    await input.press("ControlOrMeta+a");
    await input.press("Backspace");
    await expect(input).toHaveValue("");
    await expect.poll(selected).toEqual([]);
  });
}

test("Server dialog visibly labels the feature Experimental", async ({ page }) => {
  await page.route("**/api/server-files?**", route => route.fulfill({ json: { available: true, navigation: true, results: [], checkedAt: null } }));
  await establishDemoSession(page, "example-user");
  await page.locator(".landing-band").getByRole("button", { name: "Archivos del servidor", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Archivos del servidor", exact: true }).getByText("Experimental", { exact: true })).toBeVisible();
});
