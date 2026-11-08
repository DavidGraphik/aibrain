import { loginDemoEmployee } from "../helpers/demo-login";
import { reloadAndReopenConversation } from "../helpers/reopen-conversation";
import { devices, expect, test, type Locator, type Page } from "@playwright/test";

const accountName = process.env.AIBRAIN_UI_INSTALLATION === "northwind-qa" ? "Taylor" : "Alex";
const { defaultBrowserType: _defaultBrowserType, ...iphone13 } = devices["iPhone 13"];

test.use(iphone13);

async function login(page: Page) {
  await loginDemoEmployee(page, accountName);
}

async function expectTouchTarget(locator: Locator) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
}

for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test(`coarse-pointer composer controls stay touchable at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await login(page);

    await expectTouchTarget(page.getByRole("button", { name: "Añadir al mensaje" }));
    if (viewport.width >= 480) {
      await expectTouchTarget(page.getByRole("button", { name: "Destino de la conversación" }));
    } else {
      await expect(page.locator(".composer-landing .composer-destination")).toBeHidden();
    }
    await expectTouchTarget(page.getByRole("button", { name: "Experiencia" }));
    await expectTouchTarget(page.getByRole("button", { name: "Dictar mensaje" }));

    await page.getByRole("textbox", { name: "Mensaje" }).fill("Comprobar controles táctiles");
    await expectTouchTarget(page.getByRole("button", { name: "Enviar mensaje" }));

    if (viewport.width < 768) {
      await page.getByRole("button", { name: "Mostrar u ocultar la barra lateral" }).click();
      await expect(page.getByRole("dialog", { name: "Navegación" })).toBeVisible();
    }
    await expectTouchTarget(page.getByRole("button", { name: /Contraer|Expandir/ }).first());
    await expectTouchTarget(page.getByRole("button", { name: /Acciones de/ }).first());
  });
}

test("long user content and its editor remain inside a 320px touch viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await login(page);
  const longToken = `https://example.test/${"a".repeat(240)}`;

  await page.evaluate((content) => {
    const previewKey = Object.keys(localStorage).find((key) => key.endsWith(".workbench.preview.v1"));
    if (!previewKey) throw new Error("preview key missing");
    const snapshot = JSON.parse(localStorage.getItem(previewKey) ?? "null");
    const project = snapshot.projects[0];
    const now = new Date().toISOString();
    const threadId = crypto.randomUUID();
    snapshot.threads.unshift({
      id: threadId,
      projectId: project.id,
      title: "Contenido largo sintético",
      status: "active",
      pinned: false,
      createdAt: now,
      updatedAt: now,
      messages: [{
        id: crypto.randomUUID(),
        role: "user",
        content,
        createdAt: now,
        status: "complete",
        activity: [], plan: [], approvals: [], diff: "", attachments: [], artifacts: [],
      }],
    });
    localStorage.setItem(previewKey, JSON.stringify(snapshot));
    const prefix = previewKey.slice(0, -"workbench.preview.v1".length);
    localStorage.setItem(`${prefix}selection.v1`, JSON.stringify({
      activeProjectId: project.id,
      threadByProject: { [project.id]: threadId },
    }));
  }, longToken);
  await reloadAndReopenConversation(page);

  const composer = page.getByRole("textbox", { name: "Mensaje" });
  await expect(composer).toBeVisible();
  expect(
    await composer.evaluate((element) => element.scrollHeight - element.clientHeight),
    "the idle 320px composer must not clip its full placeholder",
  ).toBeLessThanOrEqual(1);

  const message = page.locator("article.flex.justify-end").filter({ hasText: "https://example.test/" });
  await expect(message).toBeVisible();
  const bubble = message.locator(":scope > div > div").first();
  expect(await bubble.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);

  const edit = message.getByRole("button", { name: "Editar mensaje y crear una rama" });
  await expectTouchTarget(edit);
  await edit.click();
  const textarea = message.getByRole("textbox", { name: "Editar mensaje" });
  const [textareaBox, bubbleBox] = await Promise.all([textarea.boundingBox(), bubble.boundingBox()]);
  expect(textareaBox).not.toBeNull();
  expect(bubbleBox).not.toBeNull();
  expect(textareaBox!.x).toBeGreaterThanOrEqual(bubbleBox!.x);
  expect(textareaBox!.x + textareaBox!.width).toBeLessThanOrEqual(bubbleBox!.x + bubbleBox!.width + 1);
  expect(textareaBox!.x + textareaBox!.width).toBeLessThanOrEqual(321);
  expect(await textarea.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
});
