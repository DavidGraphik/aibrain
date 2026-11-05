import { test, expect } from "@playwright/test";

for (const width of [1440, 390]) {
  test(`Server selection survives refresh and reaches the turn on ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    let version = 1;
    await page.route("**/api/chat", route => route.fulfill({ status: 200,
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
      body: `${JSON.stringify({ type: "delta", value: "Referencia recibida." })}\n${JSON.stringify({ type: "done" })}\n`,
    }));
    const folder = { path: "server-arnall/Y/QA", name: "QA", kind: "directory", size: 0, modifiedAt: null };
    await page.route("**/api/server-files?**", async route => {
      const query = new URL(route.request().url()).searchParams.get("query");
      if (query === "home") {
        await route.fulfill({ json: { available: true, navigation: true, sourceChecked: false, checkedAt: null, results: [folder], nextQuery: null } });
        return;
      }
      const root = query === "server:/";
      await route.fulfill({ json: { available: true, sourceChecked: true, checkedAt: new Date().toISOString(), nextQuery: null,
        results: root ? [folder] : [{ ...folder, path: `server-arnall/Y/QA/Version${version}.txt`, name: `Version${version}.txt`, kind: "file", size: version }] } });
    });
    await page.goto("/login");
    await page.getByRole("button", { name: /Alex/ }).click();
    const composer = page.getByRole("textbox", { name: "Mensaje", exact: true });
    await composer.fill("Revisa la referencia seleccionada");
    await page.getByRole("button", { name: "Archivos del servidor", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Archivos del servidor", exact: true });
    await expect(dialog.getByLabel("Adjuntar QA", { exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Explorar unidades", exact: true }).click();
    await dialog.getByLabel("Adjuntar QA", { exact: true }).check();
    await dialog.getByRole("button", { name: "Abrir QA", exact: true }).click();
    await expect(dialog.getByText("Version1.txt", { exact: true })).toBeVisible();
    version = 2;
    await dialog.getByLabel("Actualizar desde Windows").click();
    await expect(dialog.getByText("Version2.txt", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Version1.txt", { exact: true })).toHaveCount(0);
    await dialog.getByLabel("Adjuntar Version2.txt").check();
    await dialog.getByRole("button", { name: "Adjuntar referencias" }).click();
    await expect(composer).toHaveValue("Revisa la referencia seleccionada");
    await expect(page.getByLabel("Quitar referencia Version2.txt")).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Quitar referencia Version2.txt")).toBeVisible();
    await expect(composer).toHaveValue("Revisa la referencia seleccionada");
    expect(await page.locator("body").evaluate(el => el.scrollWidth)).toBeLessThanOrEqual(width);
    await page.getByRole("button", { name: "Añadir al mensaje", exact: true }).click();
    await page.getByRole("menuitem", { name: "Archivos del servidor", exact: true }).click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page.getByLabel("Quitar referencia QA", { exact: true }).click();
    const request = page.waitForRequest(req => req.url().endsWith("/api/chat") && req.method() === "POST");
    await page.getByRole("button", { name: "Enviar mensaje", exact: true }).click();
    const body = (await request).postDataJSON();
    expect(body.options.serverReferences).toEqual([{ ...folder, path: "server-arnall/Y/QA/Version2.txt", name: "Version2.txt", kind: "file", size: 2 }]);
    await expect(page.getByText("Archivo del servidor · Version2.txt", { exact: true })).toBeVisible();
  });
}
