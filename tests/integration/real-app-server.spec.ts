import { expect, test } from "@playwright/test";

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object response.");
  return value as Record<string, unknown>;
}

test("synthetic employee turn reaches the real Codex App Server and resumes the thread", async ({ page }) => {
  test.skip(!process.env.AIBRAIN_REAL_RUNTIME_BASE_URL, "requires an explicitly authorized real runtime target");
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("requestfailed", (request) => {
    if (!request.failure()?.errorText.includes("ERR_ABORTED")) failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText}`);
  });

  await page.goto("/login");
  await page.getByRole("button", { name: /Alex|AiBrain Studio/ }).click();
  const writeDirectly = page.getByText(/Prefereixo escriure directament|Prefiero escribir directamente/, { exact: true });
  await expect(writeDirectly).toBeVisible();
  await writeDirectly.click();
  const composer = page.getByRole("textbox", { name: /Mensaje|Missatge/ });
  await expect(composer).toBeVisible();

  const runtimeResult = await page.evaluate(async () => {
    const response = await fetch("/api/runtime/status");
    return { status: response.status, body: await response.json() as unknown };
  });
  expect(runtimeResult.status).toBe(200);
  const runtime = asRecord(runtimeResult.body);
  expect(runtime.mode).toBe("codex");
  expect(runtime.ready).toBe(true);
  expect(runtime.isolated).toBe(true);

  await composer.fill("Responde exactamente con AIBRAIN_RUNTIME_SMOKE_OK y nada más. Es una comprobación sintética de solo lectura.");
  await page.getByRole("button", { name: /Enviar mensaje|Enviar missatge/ }).click();
  await expect(page.getByText("AIBRAIN_RUNTIME_SMOKE_OK", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Detener|Atura/ })).toHaveCount(0);

  await composer.fill("En esta misma conversación, responde exactamente con AIBRAIN_RUNTIME_RESUME_OK y nada más.");
  await page.getByRole("button", { name: /Enviar mensaje|Enviar missatge/ }).click();
  await expect(page.getByText("AIBRAIN_RUNTIME_RESUME_OK", { exact: true })).toBeVisible();
  await expect(page.getByText("AIBRAIN_RUNTIME_SMOKE_OK", { exact: true })).toHaveCount(1);
  await page.screenshot({ path: "artifacts/ui-parity/checkpoint-08/real-app-server-resume-1280x720.png", fullPage: true });

  await composer.fill("Empieza una explicación larga con datos únicamente sintéticos para comprobar la cancelación del turno.");
  await page.getByRole("button", { name: /Enviar mensaje|Enviar missatge/ }).click();
  const stop = page.getByRole("button", { name: /Detener|Atura/ });
  await expect(stop).toBeVisible();
  await stop.click();
  const stoppedMessage = page.getByText(/Respuesta detenida|Resposta aturada|Torn aturat/);
  await expect(stoppedMessage).toBeVisible();
  await stoppedMessage.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "artifacts/ui-parity/checkpoint-08/real-app-server-cancelled-1280x720.png", fullPage: true });

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});
