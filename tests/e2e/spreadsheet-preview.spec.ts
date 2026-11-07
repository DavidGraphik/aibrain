import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) {
  test(`source workbook preview stays inside the chat at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const url = "/api/projects/00000000-0000-4000-8000-000000000011/files?path=preview.json&raw=1&download=1";
    await page.route("**/api/chat", (route) => route.fulfill({ contentType: "application/x-ndjson", body: [
      { type: "delta", value: "Pots revisar els horaris desats. Dades sintètiques de prova." },
      { type: "artifact", item: { id: "00000000-0000-4000-8000-000000000099", type: "document", name: "Horaris.xlsm",
        kind: "text", mimeType: "application/json", size: 1000, status: "ready", pages: null, previewFormat: "spreadsheet",
        url, previewUrl: url, publicationStatus: null, publicationError: null, targetLabel: null, error: null } },
      { type: "done" },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n" }));
    await page.route("**/api/projects/*/files?*", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({
      schemaVersion: 1, kind: "spreadsheet", truncated: false, sheets: [
        { name: "S’Agaró", hidden: false, cells: [{ address: "A1", value: "Treballador (prova)" }, { address: "B1", value: "Entrada" }, { address: "C1", value: "Sortida" }, { address: "A2", value: "Persona fictícia" }, { address: "B2", value: "09:00" }, { address: "C2", value: "17:00" }] },
        { name: "Torre", hidden: false, cells: [{ address: "C3", value: "10:30" }] },
      ],
    }) }));
    await page.goto("/login");
    await page.getByRole("button", { name: /Alex/ }).click();
    await page.getByRole("textbox", { name: "Mensaje" }).fill("Mostra els horaris.");
    await page.getByRole("button", { name: "Enviar mensaje" }).click();
    await page.getByRole("button", { name: "Ver hojas del libro" }).click();
    const preview = page.getByLabel("Vista previa de Horaris.xlsm");
    const sheetPicker = page.getByRole("combobox", { name: "Hoja del libro" });
    await expect(preview).toBeVisible();
    await expect(sheetPicker).toBeVisible();
    await expect(page.getByRole("cell", { name: "09:00" })).toBeVisible();
    await expect(page.getByText(/macros desactivadas/i)).toBeVisible();
    await expect.poll(() => preview.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.left >= 0 && bounds.top >= 0 && bounds.right <= document.documentElement.clientWidth &&
        bounds.bottom <= document.documentElement.clientHeight && document.documentElement.scrollWidth <= window.innerWidth;
    })).toBe(true);
    await page.screenshot({ path: `test-results/spreadsheet-${width}.png` });
    await page.getByRole("button", { name: "Pantalla completa" }).click();
    await expect(page.getByRole("button", { name: "Salir de pantalla completa" })).toBeVisible();
    await expect.poll(() => preview.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return Math.abs(bounds.left) < 1 && Math.abs(bounds.top) < 1 &&
        Math.abs(bounds.width - window.innerWidth) < 1 && Math.abs(bounds.height - window.innerHeight) < 1;
    })).toBe(true);
    await page.getByRole("button", { name: "Salir de pantalla completa" }).click();
    await sheetPicker.selectOption("1");
    await expect(page.getByRole("cell", { name: "10:30" })).toBeVisible();
    await page.getByRole("button", { name: "Cerrar vista previa" }).click();
    await expect(page.getByRole("textbox", { name: "Mensaje" })).toBeVisible();
  });
}

test("a 40-column XLSX reaches its last value in the mobile preview", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const previewUrl = "/api/threads/00000000-0000-4000-8000-000000000013/artifacts/00000000-0000-4000-8000-000000000099?preview=1";
  await page.route("**/api/chat", (route) => route.fulfill({ contentType: "application/x-ndjson", body: [
    { type: "artifact", item: { id: "00000000-0000-4000-8000-000000000099", type: "document", name: "Informe.xlsx",
      kind: "xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 1000,
      status: "ready", pages: null, url: previewUrl.replace("preview=1", "download=1"), previewUrl,
      publicationStatus: null, publicationError: null, targetLabel: null, error: null } },
    { type: "done" },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n" }));
  await page.route("**/api/threads/*/artifacts/*?grid=1", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({
    schemaVersion: 1, kind: "spreadsheet", truncated: false,
    sheets: [{ name: "Dades", hidden: false, cells: Array.from({ length: 40 }, (_, index) => {
      let n = index + 1;
      let column = "";
      while (n > 0) { column = String.fromCharCode(65 + (n - 1) % 26) + column; n = Math.floor((n - 1) / 26); }
      return { address: `${column}2`, value: `Valor ${index + 1}` };
    }) }],
  }) }));
  await page.goto("/login");
  await page.getByRole("button", { name: /Alex/ }).click();
  await page.getByRole("textbox", { name: "Mensaje" }).fill("Mostra l’informe.");
  await page.getByRole("button", { name: "Enviar mensaje" }).click();
  await page.getByRole("button", { name: "Revisar antes de descargar" }).click();
  await page.getByRole("button", { name: "Datos" }).click();
  for (let index = 0; index < 3; index++) await page.getByRole("button", { name: "Más columnas" }).click();
  const last = page.getByRole("cell", { name: "Valor 40" });
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  await expect(page.getByText("AK–AN / AN")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Vista previa de Informe.xlsx" }).getByRole("link", { name: "Descargar Informe.xlsx" }))
    .toHaveAttribute("href", previewUrl.replace("preview=1", "download=1"));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
