import { expect, test, type Page } from "@playwright/test";
import { establishDemoSession, submitPrompt } from "../helpers/playwright-auth";

const demoUserId = process.env.AIBRAIN_UI_INSTALLATION === "northwind-qa" ? "operations-user" : "example-user";
const events = [
  { type: "plan", explanation: "Fixture visual", steps: [
    { step: "Inspeccionar el proyecto", status: "completed" },
    { step: "Preparar el cambio", status: "in_progress" },
  ] },
  { type: "activity", item: { id: "command-visual", kind: "command", label: "Comprobar proyecto", detail: "Lectura sintética terminada", output: "status: clean", status: "complete" } },
  { type: "diff", value: "diff --git a/resultado.txt b/resultado.txt\n--- a/resultado.txt\n+++ b/resultado.txt\n@@ -1 +1 @@\n-Pendiente\n+Completado" },
  { type: "approval", item: { id: "018f5f68-4a6e-7abc-8def-012345678921", threadId: "018f5f68-4a6e-7abc-8def-012345678922", turnId: "018f5f68-4a6e-7abc-8def-012345678923", itemId: "018f5f68-4a6e-7abc-8def-012345678924", kind: "command", title: "Ejecutar comprobación", detail: "Comprueba únicamente el estado sintético.", command: "check --synthetic", cwd: "/workspace/synthetic", status: "pending" } },
  { type: "delta", value: "## Resultado preparado\n\nEl turno sintético está listo para revisión." },
  { type: "done" },
];

async function openSyntheticTurn(page: Page) {
  await page.route("**/api/chat", (route) => route.fulfill({
    status: 200,
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
    body: `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  }));
  await establishDemoSession(page, demoUserId);
  await submitPrompt(page, "Ejecuta una comprobación sintética.");
  await expect(page.getByRole("heading", { name: "Resultado preparado" })).toBeVisible();
  await page.locator("nextjs-portal").evaluateAll((nodes) => nodes.forEach((node) => node.remove()));
}

test("turn activity and approval", async ({ page }) => {
  await openSyntheticTurn(page);
  const approval = page.getByRole("group", { name: "Aprobación: Ejecutar comprobación" });
  await approval.scrollIntoViewIfNeeded();
  await expect(approval).toBeVisible();
  await expect(page).toHaveScreenshot("turn-approval.png", { fullPage: true });
});

test("Review diff", async ({ page }) => {
  await openSyntheticTurn(page);
  await page.getByRole("button", { name: "Abrir cambios y resultados" }).click();
  await expect(page.getByRole("heading", { name: "Cambios y resultados del turno" })).toBeVisible();
  await expect(page).toHaveScreenshot("review-diff.png", { fullPage: true });
});
test("turn activity and approval dark", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openSyntheticTurn(page);
  const approval = page.getByRole("group", { name: "Aprobación: Ejecutar comprobación" });
  await approval.scrollIntoViewIfNeeded();
  await expect(approval).toBeVisible();
  await expect(page).toHaveScreenshot("turn-approval-dark.png", { fullPage: true });
});

test("Review diff dark", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openSyntheticTurn(page);
  await page.getByRole("button", { name: "Abrir cambios y resultados" }).click();
  await expect(page.getByRole("heading", { name: "Cambios y resultados del turno" })).toBeVisible();
  await expect(page).toHaveScreenshot("review-diff-dark.png", { fullPage: true });
});
