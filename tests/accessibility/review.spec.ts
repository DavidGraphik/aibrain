import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const accountName = process.env.AIBRAIN_UI_INSTALLATION === "northwind-qa" ? "Taylor" : "Alex";

test("turn activity and approval have no critical or serious axe violations", async ({ page }) => {
  const events = [
    { type: "plan", explanation: null, steps: [{ step: "Revisar el proyecto", status: "completed" }] },
    { type: "activity", item: { id: "summary-a11y", kind: "reasoning", label: "Raonament completat", detail: "He delimitado la comprobación pública", sequence: 1, status: "complete" } },
    { type: "activity", item: { id: "command-a11y", kind: "command", label: "Comprobar proyecto", detail: "Lectura sintética terminada", output: "status: clean", sequence: 2, status: "complete" } },
    { type: "toolResult", item: { id: "command-a11y", kind: "command", title: "Comprobar proyecto", status: "complete", summary: "Código de salida 0", output: "status: clean", sourceIds: [], createdAt: "2026-08-30T10:00:02.000Z", sequence: 2 } },
    { type: "activity", item: { id: "summary-ready-a11y", kind: "reasoning", label: "Raonament completat", detail: "La comprobación ha terminado correctamente", sequence: 3, status: "complete" } },
    { type: "diff", value: "diff --git a/resultado.txt b/resultado.txt\n--- a/resultado.txt\n+++ b/resultado.txt\n@@ -1 +1 @@\n-Pendiente\n+Completado" },
    { type: "approval", item: { id: "018f5f68-4a6e-7abc-8def-012345678901", threadId: "018f5f68-4a6e-7abc-8def-012345678902", turnId: "018f5f68-4a6e-7abc-8def-012345678903", itemId: "018f5f68-4a6e-7abc-8def-012345678904", kind: "command", title: "Ejecutar comprobación", detail: "Comprueba únicamente el estado sintético.", command: "check --synthetic", cwd: "/workspace/synthetic", status: "pending" } },
    { type: "delta", value: "## Resultado preparado\n\nEl turno está listo." },
    { type: "done", durationMs: 92_000 },
  ];
  await page.route("**/api/chat", (route) => route.fulfill({
    status: 200,
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
    body: `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  }));
  await page.goto("/login");
  await page.getByRole("button", { name: new RegExp(accountName) }).click();
  await page.getByRole("textbox", { name: "Mensaje" }).fill("Ejecuta una comprobación sintética.");
  await page.getByRole("button", { name: "Enviar mensaje" }).click();
  await expect(page.getByRole("group", { name: "Aprobación: Ejecutar comprobación" })).toBeVisible();

  const assertNoBlockingViolations = async () => {
    // Measure the settled terminal state, after its finite fade-in completes.
    await page.locator(".codex-thinking-summary-complete").evaluateAll(async elements => {
      await Promise.all(elements.flatMap(element => element.getAnimations()).map(animation => animation.finished.catch(() => undefined)));
    });
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.filter((violation) =>
      violation.impact === "critical" || violation.impact === "serious",
    )).toEqual([]);
  };
  await assertNoBlockingViolations();
  await page.getByRole("button", { name: "Mostrar el proceso de trabajo" }).click();
  await expect(page.getByRole("list", { name: "Actividad del trabajo" })).toBeVisible();
  await assertNoBlockingViolations();
  await expect(page.getByRole("button", { name: "Revisar resultados" })).toHaveCount(0);
});
