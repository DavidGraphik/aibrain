import { reloadAndReopenConversation } from "../helpers/reopen-conversation";
import { expect, test } from "@playwright/test";

const accountName = process.env.AIBRAIN_UI_INSTALLATION === "northwind-qa" ? "Taylor" : "Alex";

test("a delayed high-frequency stream stays interactive, ordered and duplicate-free after refresh", async ({ page }) => {
  let releaseResponse!: () => void;
  const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
  const fragments = ["## Resultado de rendimiento\n\n", ...Array.from({ length: 240 }, (_, index) => `dato-${index + 1} `)];
  const events = [
    ...fragments.map((value) => ({ type: "delta", value })),
    { type: "done" },
  ];
  await page.route("**/api/chat", async (route) => {
    await responseGate;
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
      body: `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    });
  });

  await page.goto("/login");
  await page.getByRole("button", { name: new RegExp(accountName) }).click();
  await page.getByRole("textbox", { name: "Mensaje" }).fill("Procesa un stream sintético de alta frecuencia.");
  await page.getByRole("button", { name: "Enviar mensaje" }).click();
  await expect(page.getByRole("button", { name: "Detener respuesta" })).toBeVisible();

  const accountButton = page.getByRole("button", { name: new RegExp(`${accountName}.*Abrir menú de cuenta`) });
  await accountButton.click();
  await page.getByRole("menu", { name: "Cuenta y preferencias" }).getByRole("menuitem", { name: "Configuración" }).click();
  await expect(page.getByRole("dialog", { name: /Configuración de/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: /Configuración de/ })).toBeHidden();

  releaseResponse();
  await expect(page.getByRole("heading", { name: "Resultado de rendimiento" })).toBeVisible();
  await expect(page.getByText(/dato-1 dato-2 dato-3/)).toBeVisible();
  await expect(page.getByText(/dato-238 dato-239 dato-240/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Detener respuesta" })).toHaveCount(0);

  await reloadAndReopenConversation(page);
  await expect(page.getByRole("heading", { name: "Resultado de rendimiento" })).toHaveCount(1);
  await expect(page.getByText(/dato-238 dato-239 dato-240/)).toHaveCount(1);
});
