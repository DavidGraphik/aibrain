import { expect, test, type Page } from "@playwright/test";

const accountName = process.env.AIBRAIN_UI_INSTALLATION === "northwind-qa" ? "Taylor" : "Alex";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: new RegExp(accountName) }).click();
  await expect(page.getByTestId("composer")).toBeVisible();
}

test("plan, command, diff and legacy approvals remain inspectable without decision buttons", async ({ page }) => {
  const decisions: unknown[] = [];
  const uuid = "fc71a2c4-0db0-4914-af82-9564038ea964";
  const internalPath = `/var/lib/aibrain/data/users/${uuid}/runtime/codex-home/skills/web/SKILL.md`;
  await page.route("**/api/runtime/approvals", async (route) => {
    decisions.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route("**/api/chat", async (route) => {
    const events = [
      { type: "plan", explanation: "Fixture de contrato", steps: [
        { step: "Inspeccionar el proyecto", status: "completed" },
        { step: "Preparar el cambio", status: "in_progress" },
      ] },
      { type: "activity", item: { id: "reasoning-sensitive", kind: "reasoning", label: "Raonament completat", detail: `**Identifying access issue** Codex Instalación: company-qa ${internalPath} ${uuid}`, status: "complete" } },
      { type: "activity", item: { id: "command-qa", kind: "command", label: "Ordre executada", detail: `/bin/sh -lc "sed -n '1,260p' ${internalPath}"`, output: `status: clean\nAiBrain ${internalPath}`, status: "complete" } },
      { type: "toolResult", item: { id: "command-qa", kind: "command", title: `/bin/sh -lc "sed -n '1,260p' ${internalPath}"`, status: "complete", summary: "Código de salida 0", output: `status: clean\nAiBrain ${internalPath}`, sourceIds: [], createdAt: "2026-08-31T00:00:00.000Z" } },
      { type: "activity", item: { id: "file-qa", kind: "file", label: "Canvis de fitxers", detail: "src/resultado.ts", files: [{ path: "src/resultado.ts", change: "update" }], status: "complete" } },
      { type: "diff", value: "diff --git a/resultado.txt b/resultado.txt\n--- a/resultado.txt\n+++ b/resultado.txt\n@@ -1 +1 @@\n-Pendiente\n+Completado" },
      { type: "approval", item: { id: "approval-command", threadId: "thread-qa", turnId: "turn-qa", itemId: "item-command-qa", kind: "command", title: "Ejecutar comprobación", detail: "Comprueba únicamente el estado sintético.", command: "check --synthetic", cwd: "/workspace/synthetic", status: "pending" } },
      { type: "approval", item: { id: "approval-file", threadId: "thread-qa", turnId: "turn-qa", itemId: "item-file-qa", kind: "file", title: "Aplicar cambio preparado", detail: "Modifica únicamente resultado.txt.", status: "pending" } },
      { type: "delta", value: `## Resultado de la prueba\n\nEl turno está listo para revisión.\n\nAiBrain Instalación: company-qa ${internalPath} ${uuid}\n\n[Abrir artefacto](/api/projects/00000000-0000-4000-8000-000000000011/artifacts/00000000-0000-4000-8000-000000000012)` },
      { type: "done" },
    ];
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
      body: `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    });
  });
  await page.route("**/api/projects/*/files?*", async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ file: {
        path: url.searchParams.get("path"),
        name: "resultado.ts",
        kind: "text",
        mimeType: "text/plain",
        size: 34,
        language: "TypeScript",
        content: "export const resultado = 'listo';",
        previewUrl: null,
        previewMimeType: "text/plain",
        downloadUrl: `/api/projects/00000000-0000-4000-8000-000000000011/files?path=${encodeURIComponent(url.searchParams.get("path") ?? "")}&download=1`,
      } }),
    });
  });

  await login(page);
  await page.getByRole("textbox", { name: "Mensaje" }).fill("Ejecuta el turno sintético de Review.");
  await page.getByRole("button", { name: "Enviar mensaje" }).click();
  const resultHeading = page.getByRole("heading", { name: "Resultado de la prueba" });
  await expect(resultHeading).toBeVisible();
  const assistantTurn = resultHeading.locator("xpath=ancestor::article");
  const activityToggle = assistantTurn.getByRole("button", { name: "Mostrar el proceso de trabajo" });
  await expect(activityToggle).toHaveAttribute("aria-expanded", "false");
  await activityToggle.click();
  await expect(assistantTurn.getByText("Inspeccionar el proyecto", { exact: true })).toBeVisible();
  await expect(assistantTurn.getByText("Identifying access issue", { exact: false })).toBeVisible();
  await expect(page.getByText("Consultando archivos del proyecto")).toBeVisible();
  await expect(assistantTurn).not.toContainText("/var/lib");
  await expect(assistantTurn).not.toContainText("company-qa");
  await expect(assistantTurn).not.toContainText(uuid);
  await expect(assistantTurn).not.toContainText("Codex");
  await expect(assistantTurn).not.toContainText("AiBrain");
  await expect(assistantTurn.getByRole("link", { name: "Abrir artefacto" })).toHaveAttribute(
    "href",
    "/api/projects/00000000-0000-4000-8000-000000000011/artifacts/00000000-0000-4000-8000-000000000012",
  );
  await page.getByRole("button", { name: /src\/resultado\.ts/ }).click();
  await expect(page.getByText("export const resultado = 'listo';")).toBeVisible();
  const reviewButton = assistantTurn.getByRole("button", { name: "Abrir cambios y resultados" });
  await expect(reviewButton).toBeVisible();
  await reviewButton.click();
  const reviewPanel = page.locator('aside[aria-label="Cambios y resultados del turno"]');
  await expect(reviewPanel).toBeVisible();
  await reviewPanel.getByRole("button", { name: "Cerrar cambios y resultados" }).click();
  await expect(reviewPanel).toBeHidden();

  for (const title of ["Ejecutar comprobación", "Aplicar cambio preparado"]) {
    const approval = page.getByRole("group", { name: `Aprobación: ${title}` });
    await expect(approval.getByRole("status")).toHaveText("Confirma la acción en el chat");
    await expect(approval.getByRole("button")).toHaveCount(0);
    await expect(approval.getByText("Esta tarjeta pertenece a una solicitud anterior.", { exact: false })).toBeVisible();
  }
  expect(decisions).toEqual([]);

  await expect(page.locator('button.result-action[aria-label="Copiar"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Revisar resultados" })).toHaveCount(0);
  await expect(page.getByText("Incluidos en este turno")).toBeVisible();
});

test("a network failure pauses and resumes the same request without an unhandled page error", async ({ page }) => {
  const pageErrors: string[] = [];
  const requests: string[] = [];
  let restored = false;
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.route("**/api/chat", route => {
    requests.push(route.request().postData()!);
    return route.fulfill(restored ? {
      status: 200, contentType: "application/x-ndjson",
      body: JSON.stringify({ type: "delta", value: "Respuesta recuperada" }) + "\n" + JSON.stringify({ type: "done" }) + "\n",
    } : { status: 503, contentType: "application/json", body: JSON.stringify({ error: "Servicio sintético no disponible." }) });
  });
  await login(page);
  await page.clock.install();
  await page.getByRole("textbox", { name: "Mensaje" }).fill("Provoca un error de red sintético.");
  await page.getByRole("button", { name: "Enviar mensaje" }).click();
  await expect.poll(() => requests.length).toBe(1);
  for (let i = 2; i <= 9; i++) {
    await page.clock.fastForward(10_000);
    await expect.poll(() => requests.length).toBe(i);
  }
  const retry = page.getByRole("button", { name: "Reconectar respuesta", exact: true });
  await expect(retry).toBeVisible();
  await expect(page.getByText("No se puede comprobar la respuesta ahora. El trabajo y los resultados guardados se conservan.")).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "No se ha podido completar esta respuesta" })).toHaveCount(0);
  await page.clock.fastForward(300_000);
  expect(requests).toHaveLength(9);
  restored = true;
  await retry.click();
  await page.clock.fastForward(2_000);
  await expect(page.getByText("Respuesta recuperada", { exact: true })).toBeVisible();
  expect(requests).toHaveLength(10);
  expect(new Set(requests).size).toBe(1);
  expect(pageErrors).toEqual([]);
});
