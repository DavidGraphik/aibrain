import { expect, test } from "@playwright/test";
import { generatedPngFixture } from "../helpers/png-fixture";
import { mkdir } from "node:fs/promises";
import path from "node:path";

test("plus, chat drop and paste keep image attachments in the unsent draft", async ({ page, baseURL }) => {
  await page.route("**/api/runtime/status**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      tenantId: "example-lab-dev",
      projectId: null,
      projectName: "Example Laboratory",
      mode: "demo",
      codex: "disabled",
      isolated: false,
      ready: true,
      authMode: null,
      planType: null,
      processWarm: true,
      rateLimit: null,
      usage: null,
      workspaceName: "workspace",
      model: null,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      models: [],
      skills: [],
      capabilities: { webSearch: false, imageInput: true, imageGeneration: false },
    }),
  }));
  const login = await page.request.post("/api/auth/login", { headers: { Origin: new URL(baseURL!).origin }, data: { userId: "example-user" } });
  expect(login.status()).toBe(200);
  await page.goto("/");
  const composer = page.getByTestId("composer");
  await expect(composer).toBeVisible();
  await expect(page.getByRole("main")).toHaveAttribute("aria-busy", "false");
  const prompt = page.getByRole("textbox", { name: "Mensaje" });
  await prompt.fill("Keep this private draft");
  let sends = 0;
  let publications = 0;
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/chat" && request.method() === "POST") sends += 1;
    if (pathname.includes("publication") && request.method() === "POST") publications += 1;
  });
  const png = generatedPngFixture();
  await page.getByLabel("Seleccionar archivos para adjuntar").setInputFiles({ name: "plus.png", mimeType: "image/png", buffer: png });
  await expect(composer.getByRole("img", { name: "Vista previa de plus.png" })).toBeVisible();
  const transfer = await page.evaluateHandle((bytes) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)], "drop.png", { type: "image/png" }));
    return data;
  }, Array.from(png));
  await page.getByRole("main").dispatchEvent("dragenter", { dataTransfer: transfer });
  await expect(page.getByText("Suelta los archivos para adjuntarlos")).toBeVisible();
  await page.getByRole("main").dispatchEvent("drop", { dataTransfer: transfer });
  await expect(composer.getByRole("img", { name: "Vista previa de drop.png" })).toBeVisible();
  await expect(page.getByText("Suelta los archivos para adjuntarlos")).toHaveCount(0);
  await prompt.evaluate((element, bytes) => {
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([new Uint8Array(bytes)], "paste.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  }, Array.from(png));
  await expect(composer.getByRole("img", { name: "Vista previa de paste.png" })).toBeVisible();
  await expect(prompt).toHaveValue("Keep this private draft");
  expect(sends).toBe(0);
  expect(publications).toBe(0);
  await expect(page.getByText("Destino oficial")).toHaveCount(0);
  await composer.getByRole("button", { name: "Quitar drop.png" }).click();
  await expect(composer.getByRole("img", { name: "Vista previa de drop.png" })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileSelector = page.getByLabel("Seleccionar archivos para adjuntar");
  await expect(mobileSelector).toBeAttached();
  await expect(mobileSelector).toBeEnabled();
  await mobileSelector.setInputFiles({ name: "mobile-selector.png", mimeType: "image/png", buffer: png });
  await expect(composer.getByRole("img", { name: "Vista previa de mobile-selector.png" })).toBeVisible();
  expect(sends).toBe(0);
  expect(publications).toBe(0);
  if (process.env.AIBRAIN_FILES_EVIDENCE_DIR) {
    const evidence = process.env.AIBRAIN_FILES_EVIDENCE_DIR;
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: path.join(evidence, "draft-desktop-light.png") });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({ path: path.join(evidence, "draft-desktop-dark.png") });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: path.join(evidence, "draft-mobile-dark.png") });
    await page.getByRole("button", { name: "Mostrar u ocultar la barra lateral" }).click();
    await expect(page.getByTestId("sidebar-brand")).toBeVisible();
    await page.screenshot({ path: path.join(evidence, "brand-mobile-dark.png") });
  }
  await prompt.fill("");
  const send = composer.getByRole("button", { name: "Enviar mensaje", exact: true });
  await expect(send).toBeEnabled();
  await page.route("**/api/chat", (route) => route.fulfill({
    status: 200, contentType: "application/x-ndjson",
    body: JSON.stringify({ type: "done" }) + "\n",
  }));
  const attachmentOnlyRequest = page.waitForRequest((request) =>
    new URL(request.url()).pathname === "/api/chat" && request.method() === "POST");
  await send.click();
  const submitted = (await attachmentOnlyRequest).postDataJSON();
  expect(submitted.message).toBe("");
  expect(submitted.options.attachments.length).toBeGreaterThan(0);
  expect(submitted.options.attachments.some((attachment: { name: string }) => attachment.name === "mobile-selector.png")).toBe(true);

});
