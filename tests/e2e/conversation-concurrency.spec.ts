import { expect, test, type Page, type Route } from "@playwright/test";

const primaryProject = process.env.AIBRAIN_UI_INSTALLATION === "northwind-qa" ? "Operacions" : "Espacio principal";
const demoUserId = process.env.AIBRAIN_UI_INSTALLATION === "northwind-qa" ? "operations-user" : "example-user";

async function login(page: Page) {
  await page.goto("/login");
  const origin = new URL(page.url()).origin;
  const response = await page.context().request.post(`${origin}/api/auth/login`, {
    data: { userId: demoUserId },
    headers: { Origin: origin },
  });
  expect(response.ok()).toBe(true);
  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible();
}

function releaseGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function completeRoute(route: Route, content: string) {
  await route.fulfill({
    status: 200,
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
    body: `${JSON.stringify({ type: "delta", value: content })}\n${JSON.stringify({ type: "done" })}\n`,
  }).catch(() => {
    // An intentionally cancelled request may already be closed by Chromium.
  });
}

test("conversations run independently, cancel independently and notify on background completion", async ({ page }) => {
  const first = releaseGate();
  const second = releaseGate();
  let chatRequests = 0;

  await page.route("**/api/chat", async (route) => {
    chatRequests += 1;
    if (chatRequests === 1) {
      await first.promise;
      await completeRoute(route, "Primera tarea completada.");
      return;
    }
    await second.promise;
    await completeRoute(route, "Esta respuesta se canceló.");
  });

  await login(page);
  // Home intentionally starts in personal conversations. Project activity is
  // exercised only after the employee explicitly chooses that project.
  await expect(page.getByLabel("Destino de la conversación")).toHaveText("Proyecto");
  await page.getByRole("button", { name: primaryProject, exact: true }).click();
  await expect(page.getByLabel("Destino de la conversación")).toContainText(primaryProject);
  await page.getByRole("textbox", { name: "Mensaje" }).fill("Primera tarea en segundo plano");
  await page.getByRole("button", { name: "Enviar mensaje" }).click();
  await expect.poll(() => chatRequests).toBe(1);
  await expect(page.getByRole("button", { name: "Detener respuesta" })).toBeVisible();

  await page.getByRole("button", { name: "Nueva conversación", exact: true }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: /¿En qué te puedo ayudar, .+\?/ })).toBeVisible();
  const composer = page.getByRole("textbox", { name: "Mensaje" });
  await composer.fill("Segunda tarea cancelable");
  await page.getByRole("button", { name: /^Primera tarea en segundo plano/ }).click();
  await expect(page.getByRole("textbox", { name: "Mensaje" })).toHaveValue("");
  await page.getByRole("button", { name: "Nueva conversación", exact: true }).first().click();
  await expect(page.getByRole("textbox", { name: "Mensaje" })).toHaveValue("Segunda tarea cancelable");
  await expect(page.getByRole("button", { name: "Enviar mensaje" })).toBeEnabled();
  await page.getByRole("textbox", { name: "Mensaje" }).press("Enter");
  await expect.poll(() => chatRequests).toBe(2);
  await expect(page.getByRole("textbox", { name: "Mensaje" })).toHaveValue("");

  await page.getByRole("button", { name: "Detener respuesta" }).click();
  second.release();
  await expect(page.getByRole("button", { name: "Detener respuesta" })).toHaveCount(0);

  const runningProject = page.getByRole("button", { name: new RegExp(`${primaryProject}.*1 conversación trabajando`) });
  await expect(runningProject).toBeVisible();
  await runningProject.click();

  const firstThread = page.getByRole("button", { name: /^Primera tarea en segundo plano/ });
  await expect(firstThread.getByLabel("Trabajando")).toBeVisible();
  await page.getByRole("button", { name: /^Segunda tarea cancelable(?: Hoy)?$/ }).click();

  first.release();
  const completedProject = page.getByRole("button", { name: new RegExp(`${primaryProject}.*1 actualización sin leer`) });
  await expect(completedProject).toBeVisible();

  await completedProject.click();
  await expect(page.getByText("Primera tarea completada.")).toBeVisible();
  await expect(page.getByRole("button", { name: new RegExp(`${primaryProject}.*actualización sin leer`) })).toHaveCount(0);
});
