import { expect, test } from "@playwright/test";

const accountName = process.env.AIBRAIN_UI_INSTALLATION === "northwind-qa" ? "Taylor" : "Alex";

test("a response exposes real citations and reviewable tool output inline", async ({ page }) => {
  const source = {
    id: "source-official-1", kind: "web", title: "Informe oficial",
    url: "https://example.com/informe", domain: "example.com", snippet: "Cifra publicada por la fuente.",
    publishedAt: "2026-08-20T00:00:00.000Z",
  };
  const events = [
    { type: "source", item: source },
    { type: "toolResult", item: {
      id: "crm-read-1", kind: "app", title: "CRM · Leer cuenta", status: "complete",
      summary: "Consulta de solo lectura", output: "Cuenta encontrada: Ejemplo SA",
      sourceIds: [source.id], createdAt: "2026-08-28T09:00:00.000Z",
    } },
    { type: "delta", value: "## Resultado\n\nLa cuenta está lista para revisión." },
    { type: "done" },
  ];
  await page.route("**/api/chat", (route) => route.fulfill({
    status: 200,
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
    body: `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  }));

  await page.goto("/login");
  await page.getByRole("button", { name: new RegExp(accountName) }).click();
  await page.getByRole("textbox", { name: "Mensaje" }).fill("Consulta la cuenta con fuentes.");
  await page.getByRole("button", { name: "Enviar mensaje" }).click();

  await page.getByText("Fuentes", { exact: true }).click();
  await expect(page.getByRole("link", { name: "Abrir fuente 1: Informe oficial" })).toHaveAttribute("href", source.url);
  await page.getByRole("button", { name: "Mostrar el proceso de trabajo" }).click();
  await expect(page.getByText("CRM · Leer cuenta")).toBeVisible();
  await page.getByText("CRM · Leer cuenta").click();
  await expect(page.getByLabel("Salida de CRM · Leer cuenta")).toContainText("Ejemplo SA");

  await expect(page.getByRole("button", { name: "Copiar" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Revisar resultados" })).toHaveCount(0);
});
