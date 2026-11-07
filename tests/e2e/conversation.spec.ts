import { reloadAndReopenConversation } from "../helpers/reopen-conversation";
import { expect, test, type Page } from "@playwright/test";

const accountName = process.env.AIBRAIN_UI_INSTALLATION === "northwind-qa" ? "Taylor" : "Alex";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: new RegExp(accountName) }).click();
  await expect(page.getByTestId("composer")).toBeVisible({ timeout: 15_000 });
}

test("the composer grows, accepts dropped images, stops a stream and recovers after reload", async ({ page }) => {
  await login(page);
  const composer = page.getByTestId("composer");
  const textarea = page.getByRole("textbox", { name: "Mensaje" });
  await expect(page.getByText("Conectando con el servicio…", { exact: true })).toHaveCount(0);
  await expect.poll(() => composer.evaluate((element) => getComputedStyle(element.parentElement?.parentElement ?? element).position)).toBe("absolute");
  const controls = page.locator(".composer-controls");
  const initialComposerBox = await composer.boundingBox();

  await textarea.fill("Primera línea\nSegunda línea\nTercera línea\nCuarta línea");
  await expect.poll(() => textarea.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(56);
  const grownComposerBox = await composer.boundingBox();
  const textareaBox = await textarea.boundingBox();
  const controlsBox = await controls.boundingBox();
  expect(initialComposerBox).not.toBeNull();
  expect(grownComposerBox).not.toBeNull();
  expect(textareaBox).not.toBeNull();
  expect(controlsBox).not.toBeNull();
  // The landing group stays centered as the draft grows; conversation
  // composers remain bottom-docked after the first message.
  expect(grownComposerBox!.y + grownComposerBox!.height / 2).toBeCloseTo(initialComposerBox!.y + initialComposerBox!.height / 2, 0);
  expect(grownComposerBox!.y + grownComposerBox!.height).toBeGreaterThan(initialComposerBox!.y + initialComposerBox!.height);
  expect(grownComposerBox!.y + grownComposerBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  expect(grownComposerBox!.height).toBeGreaterThan(initialComposerBox!.height);
  expect(controlsBox!.y).toBeGreaterThanOrEqual(textareaBox!.y + textareaBox!.height - 1);
  await expect(page.getByRole("button", { name: "Enviar mensaje" })).toBeEnabled();

  await composer.evaluate((element) => {
    const transfer = new DataTransfer();
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII="), (character) => character.charCodeAt(0));
    transfer.items.add(new File([bytes], "arrastrada.png", { type: "image/png" }));
    element.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: transfer }));
  });
  await expect(page.getByText("Suelta los archivos para adjuntarlos", { exact: true })).toBeVisible();
  await composer.evaluate((element) => {
    const transfer = new DataTransfer();
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII="), (character) => character.charCodeAt(0));
    transfer.items.add(new File([bytes], "arrastrada.png", { type: "image/png" }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
  });
  await expect(page.getByText("arrastrada.png")).toBeVisible();

  await page.getByLabel("Seleccionar archivos para adjuntar").setInputFiles({
    name: "informe.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=", "base64"),
  });
  await expect(page.getByText("informe.png")).toBeVisible();
  await expect(page.getByText(/Lista ·/)).toHaveCount(2);

  await page.getByRole("button", { name: "Enviar mensaje" }).click();
  const userMessage = page.locator("article.flex.justify-end").filter({ hasText: "Primera línea" });
  await expect(userMessage).toBeVisible();
  const stop = page.getByRole("button", { name: "Detener respuesta" });
  await expect(stop).toBeVisible();
  await stop.click();
  await expect(page.getByText("Respuesta detenida.")).toBeVisible();
  await expect(page.getByText("informe.png")).toHaveCount(1);

  await page.waitForTimeout(250);
  await reloadAndReopenConversation(page);
  await expect(page.locator("article.flex.justify-end").filter({ hasText: "Primera línea" })).toBeVisible();
  await expect(page.getByText("Respuesta detenida.")).toBeVisible();
});

test("messages written during a turn queue and dispatch exactly once in order", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let releaseFirstResponse: () => void = () => undefined;
  const firstResponseGate = new Promise<void>((resolve) => { releaseFirstResponse = resolve; });
  const receivedMessages: string[] = [];

  await page.route("**/api/chat", async (route) => {
    const request = JSON.parse(route.request().postData() ?? "{}") as { message?: string };
    receivedMessages.push(request.message ?? "");
    const requestNumber = receivedMessages.length;
    if (requestNumber === 1) await firstResponseGate;
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
      body: [
        JSON.stringify({ type: "delta", value: `Respuesta sintética ${requestNumber}.` }),
        JSON.stringify({ type: "done" }),
        "",
      ].join("\n"),
    });
  });

  await login(page);
  const textarea = page.getByRole("textbox", { name: "Mensaje" });
  await textarea.fill("Primer mensaje en curso");
  await page.getByRole("button", { name: "Enviar mensaje" }).click();
  await expect(page.getByRole("button", { name: "Detener respuesta" })).toBeVisible();

  await textarea.fill("Segundo mensaje en cola");
  await page.getByRole("button", { name: "Añadir mensaje a la cola" }).click();
  const queue = page.locator("[data-slot='message-queue']");
  await expect(queue.getByText("Segundo mensaje en cola", { exact: true })).toBeVisible();
  expect(receivedMessages).toEqual(["Primer mensaje en curso"]);

  releaseFirstResponse();
  await expect.poll(() => receivedMessages).toEqual([
    "Primer mensaje en curso",
    "Segundo mensaje en cola",
  ]);
  await expect(page.locator("article.flex.justify-end").filter({ hasText: "Segundo mensaje en cola" })).toBeVisible();
  await expect(page.getByText("Respuesta sintética 2.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Enviar mensaje" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("governed image generation is selectable and reaches the runtime request", async ({ page }) => {
  let requestedImageGeneration: boolean | null = null;
  await page.route("**/api/runtime/status**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      tenantId: "example-lab-dev",
      projectId: "018f5f68-4a6e-7abc-8def-0123456789ab",
      projectName: "Trabajo interno",
      mode: "codex",
      codex: "connected",
      isolated: true,
      ready: true,
      authMode: "chatgpt",
      planType: "team",
      processWarm: true,
      rateLimit: null,
      usage: null,
      workspaceName: "workspace",
      model: "gpt-5.6",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      models: [],
      skills: [],
      capabilities: { webSearch: true, imageInput: true, imageGeneration: true },
    }),
  }));
  await page.route("**/api/chat", async (route) => {
    const request = JSON.parse(route.request().postData() ?? "{}") as { options?: { imageGeneration?: boolean } };
    requestedImageGeneration = request.options?.imageGeneration ?? null;
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
      body: `${JSON.stringify({ type: "done" })}\n`,
    });
  });

  await login(page);
  await page.getByRole("button", { name: "Añadir al mensaje" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Crear imagen" }).click();
  await expect(page.getByLabel("Generación de imágenes activada")).toBeVisible();
  await page.getByRole("textbox", { name: "Mensaje" }).fill("Genera una imagen de prueba");
  await page.getByRole("button", { name: "Enviar mensaje" }).click();
  await expect.poll(() => requestedImageGeneration).toBe(true);
  await expect(page.getByLabel("Generación de imágenes activada")).toHaveCount(0);
});

test("the mobile composer keeps every control below its growing text area", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);

  const composer = page.getByTestId("composer");
  const textarea = page.getByRole("textbox", { name: "Mensaje" });
  await textarea.fill("Primera línea\nSegunda línea\nTercera línea\nCuarta línea");
  await expect.poll(() => textarea.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(56);

  const textareaBox = await textarea.boundingBox();
  const controlsBox = await page.locator(".composer-controls").boundingBox();
  expect(textareaBox).not.toBeNull();
  expect(controlsBox).not.toBeNull();
  expect(controlsBox!.y).toBeGreaterThanOrEqual(textareaBox!.y + textareaBox!.height - 1);
  await expect(page.getByRole("button", { name: "Añadir al mensaje" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Enviar mensaje" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("a mobile response paints received text directly without animated auto-scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const original = Element.prototype.scrollIntoView;
    const behaviors: string[] = [];
    Object.defineProperty(window, "__aibrainScrollBehaviors", { value: behaviors });
    Element.prototype.scrollIntoView = function scrollIntoView(options?: boolean | ScrollIntoViewOptions) {
      if (typeof options === "object" && options.behavior) behaviors.push(options.behavior);
      return original.call(this, options);
    };
  });
  await login(page);
  await page.getByRole("textbox", { name: "Mensaje" }).fill("Responde con tres ideas sintéticas para comprobar el streaming móvil.");
  await page.getByRole("button", { name: "Enviar mensaje" }).click();

  const streamingMessage = page.locator(".markdown-body.t-stream");
  await expect(streamingMessage).toBeVisible({ timeout: 10_000 });
  await expect(streamingMessage.locator(".t-stream-w")).toHaveCount(0);
  await expect(streamingMessage.locator(".t-stream-caret")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Detener respuesta" })).toHaveCount(0, { timeout: 10_000 });
  expect(await page.evaluate(() => (window as typeof window & { __aibrainScrollBehaviors: string[] }).__aibrainScrollBehaviors)).not.toContain("smooth");
});

test("submit paints honest activity within one second before the chat response arrives", async ({ page }, testInfo) => {
  let releaseResponse: () => void = () => undefined;
  const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
  await page.route("**/api/chat", async (route) => {
    await responseGate;
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
      body: [
        JSON.stringify({ type: "delta", value: "Respuesta recibida sin animación artificial." }),
        JSON.stringify({ type: "done" }),
        "",
      ].join("\n"),
    });
  });
  await login(page);
  await page.getByRole("textbox", { name: "Mensaje" }).fill("Comprueba la actividad inicial.");
  await page.evaluate(() => {
    const state = window as typeof window & { __aibrainInitialFeedbackMs?: number | null };
    state.__aibrainInitialFeedbackMs = null;
    document.addEventListener("click", (event) => {
      const button = (event.target as Element | null)?.closest("button");
      if (button?.getAttribute("aria-label") !== "Enviar mensaje") return;
      const startedAt = performance.now();
      const observer = new MutationObserver(() => {
        if (!document.body.textContent?.includes("Enviando solicitud")) return;
        observer.disconnect();
        requestAnimationFrame(() => { state.__aibrainInitialFeedbackMs = performance.now() - startedAt; });
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    }, { once: true, capture: true });
  });
  await page.getByRole("button", { name: "Enviar mensaje" }).click();
  await expect(page.getByText(/^Enviando solicitud/u)).toBeVisible({ timeout: 1_000 });
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __aibrainInitialFeedbackMs?: number | null }).__aibrainInitialFeedbackMs,
  )).not.toBeNull();
  const feedbackMs = await page.evaluate(() =>
    (window as typeof window & { __aibrainInitialFeedbackMs: number }).__aibrainInitialFeedbackMs,
  );
  expect(feedbackMs).toBeLessThan(1_000);
  await testInfo.attach("initial-feedback-benchmark.json", {
    body: Buffer.from(JSON.stringify({
      scope: "real Chromium submit click to honest visible activity; mocked response held open",
      feedbackMs: Number(feedbackMs.toFixed(2)),
      budgetMs: 1_000,
      passed: true,
    }, null, 2)),
    contentType: "application/json",
  });
  console.info(`[chat-feedback-benchmark] ${feedbackMs.toFixed(2)} ms`);

  releaseResponse();
  await expect(page.getByText("Respuesta recibida sin animación artificial.", { exact: true })).toBeVisible();
});

test("automatic permission review remains server-side and invisible on desktop and mobile", async ({ page }) => {
  await page.route("**/api/runtime/status**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      tenantId: "example-lab-dev",
      projectId: "018f5f68-4a6e-7abc-8def-0123456789ab",
      projectName: "Trabajo interno",
      mode: "codex",
      codex: "connected",
      isolated: true,
      ready: true,
      authMode: "chatgpt",
      planType: "team",
      processWarm: true,
      rateLimit: null,
      usage: null,
      workspaceName: "workspace",
      model: "gpt-5.6",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      models: [],
      skills: [],
      capabilities: { webSearch: true, imageInput: true, imageGeneration: false },
    }),
  }));
  await login(page);

  const composer = page.getByTestId("composer");
  await expect(page.getByRole("button", { name: /permisos/i })).toHaveCount(0);
  await expect(page.getByText(/permisos auto/i)).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  const composerBox = await composer.boundingBox();
  expect(composerBox).not.toBeNull();
  await expect(page.getByRole("button", { name: /permisos/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Experiencia" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("the existing chat route streams a complete turn and persists it in preview storage", async ({ page }) => {
  await login(page);
  await page.getByRole("textbox", { name: "Mensaje" }).fill("Resume este contenido sintético en tres ideas claras.");
  await page.getByRole("button", { name: "Enviar mensaje" }).click();
  await expect(page.getByRole("button", { name: "Detener respuesta" })).toBeVisible();
  const liveActivity = page.getByTestId("turn-thinking-steps").last();
  const liveActivityTrigger = page.getByRole("button", { name: "Mostrar el proceso de trabajo" }).last();
  await expect(liveActivityTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(liveActivityTrigger).toHaveAttribute("data-streaming", "true");
  await expect(liveActivityTrigger).toContainText(/Analizando la petición|Revisando el proyecto|Plan preparado/);
  await expect(liveActivity.getByRole("region", { name: "Detalles del proceso de trabajo", includeHidden: true })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Vista previa" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Detener respuesta" })).toHaveCount(0, { timeout: 10_000 });
  const completedActivity = page.getByTestId("turn-thinking-steps").last();
  const completedActivityTrigger = page.getByRole("button", { name: "Mostrar el proceso de trabajo" }).last();
  await expect(completedActivityTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(completedActivityTrigger).toContainText(/Ha trabajado durante \d+m \d+s/);
  await expect(completedActivityTrigger).toHaveAttribute("data-streaming", "false");
  await completedActivityTrigger.click();
  await expect(page.getByRole("button", { name: "Ocultar el proceso de trabajo" }).last()).toHaveAttribute("aria-expanded", "true");
  await expect(completedActivity.getByText("Analizando la petición", { exact: true })).toBeVisible();

  await page.waitForTimeout(250);
  await reloadAndReopenConversation(page);
  await expect(page.locator("article.flex.justify-end").filter({ hasText: "Resume este contenido sintético" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Vista previa" })).toBeVisible();
});

test("a long recovered conversation keeps the reader in control of scroll", async ({ page }) => {
  await login(page);
  await page.evaluate(() => {
    const previewKey = Object.keys(localStorage).find((key) => key.endsWith(".workbench.preview.v1"));
    if (!previewKey) throw new Error("preview key missing");
    const snapshot = JSON.parse(localStorage.getItem(previewKey) ?? "null");
    const project = snapshot.projects[0];
    const now = new Date().toISOString();
    const threadId = crypto.randomUUID();
    const messages = Array.from({ length: 40 }, (_, index) => ({
      id: crypto.randomUUID(),
      role: index % 2 === 0 ? "user" : "assistant",
      content: `${index % 2 === 0 ? "Pregunta" : "Respuesta"} ${index + 1}: contenido sintético para validar una conversación larga sin datos privados.`,
      createdAt: new Date(Date.now() + index).toISOString(),
      status: "complete",
      activity: [],
      plan: [],
      approvals: [],
      diff: "",
      attachments: [],
      artifacts: [],
    }));
    snapshot.threads.unshift({
      id: threadId,
      projectId: project.id,
      title: "Conversación larga sintética",
      status: "active",
      pinned: false,
      createdAt: now,
      updatedAt: now,
      messages,
    });
    localStorage.setItem(previewKey, JSON.stringify(snapshot));
    const prefix = previewKey.slice(0, -"workbench.preview.v1".length);
    localStorage.setItem(`${prefix}selection.v1`, JSON.stringify({
      activeProjectId: project.id,
      threadByProject: { [project.id]: threadId },
    }));
  });
  await reloadAndReopenConversation(page);
  await expect(page.getByText("Respuesta 40:", { exact: false })).toBeVisible();

  const scroller = page.locator(".workbench-main > .scrollbar-thin");
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  const jump = page.getByRole("button", { name: "Volver al final" });
  await expect(jump).toBeVisible();
  await jump.click();
  await expect.poll(() => scroller.evaluate((element) =>
    element.scrollHeight - element.scrollTop - element.clientHeight,
  )).toBeLessThan(100);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }])
for (const detachDuringResize of [false, true]) {
  test(`active streaming preserves a detached reader at ${viewport.width}x${viewport.height}${detachDuringResize ? " during resize" : ""}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(() => {
      const state = window as Window & {
        __finishSyntheticChatStream?: () => void;
        __appendSyntheticChatStream?: () => void;
        __detachOnNextChatResize?: boolean;
      };
      const NativeResizeObserver = window.ResizeObserver;
      window.ResizeObserver = class extends NativeResizeObserver {
        constructor(callback: ResizeObserverCallback) {
          super((entries, observer) => {
            callback(entries, observer);
            if (!state.__detachOnNextChatResize || !entries.some((entry) => entry.target.classList.contains("mobile-chat-content"))) return;
            state.__detachOnNextChatResize = false;
            // Put the reader's scroll between real resize delivery and the
            // hook's deferred follow frame: the formerly flaky CI ordering.
            const scroller = document.querySelector(".workbench-main > .scrollbar-thin")!;
            scroller.scrollTop = 0;
            scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
          });
        }
      };
      const nativeFetch = window.fetch.bind(window);
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (!url.includes("/api/chat") || init?.method !== "POST") return nativeFetch(input, init);
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            let finished = false;
            state.__finishSyntheticChatStream = () => {
              if (finished) return;
              finished = true;
              controller.enqueue(encoder.encode(`${JSON.stringify({ type: "done" })}\n`));
              controller.close();
              delete state.__finishSyntheticChatStream;
            };
            window.setTimeout(() => controller.enqueue(encoder.encode(`${JSON.stringify({ type: "delta", value: "Primer fragmento sintético." })}\n`)), 80);
            state.__appendSyntheticChatStream = () => {
              controller.enqueue(encoder.encode(`${JSON.stringify({ type: "delta", value: "\n\nSegundo fragmento que debe respetar la lectura." })}\n`));
              delete state.__appendSyntheticChatStream;
            };
          },
        });
        return Promise.resolve(new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } }));
      }) as typeof window.fetch;
    });
    await login(page);
    await page.evaluate(() => {
      const previewKey = Object.keys(localStorage).find((key) => key.endsWith(".workbench.preview.v1"));
      if (!previewKey) throw new Error("preview key missing");
      const snapshot = JSON.parse(localStorage.getItem(previewKey) ?? "null");
      const project = snapshot.projects[0];
      const now = new Date().toISOString();
      const threadId = crypto.randomUUID();
      snapshot.threads.unshift({
        id: threadId,
        projectId: project.id,
        title: "Streaming largo sintético",
        status: "active",
        pinned: false,
        createdAt: now,
        updatedAt: now,
        messages: Array.from({ length: 40 }, (_, index) => ({
          id: crypto.randomUUID(),
          role: index % 2 === 0 ? "user" : "assistant",
          content: `${index % 2 === 0 ? "Pregunta" : "Respuesta"} ${index + 1}: contenido sintético suficiente para crear desplazamiento vertical estable.`,
          createdAt: new Date(Date.now() + index).toISOString(),
          status: "complete",
          activity: [], plan: [], approvals: [], diff: "", attachments: [], artifacts: [],
        })),
      });
      localStorage.setItem(previewKey, JSON.stringify(snapshot));
      const prefix = previewKey.slice(0, -"workbench.preview.v1".length);
      localStorage.setItem(`${prefix}selection.v1`, JSON.stringify({ activeProjectId: project.id, threadByProject: { [project.id]: threadId } }));
    });
    await reloadAndReopenConversation(page);

    await page.getByRole("textbox", { name: "Mensaje" }).fill("Continúa sin mover mi lectura.");
    await page.getByRole("button", { name: "Enviar mensaje" }).click();
    await expect(page.getByText("Primer fragmento sintético.", { exact: false })).toBeVisible();
    const scroller = page.locator(".workbench-main > .scrollbar-thin");
    await expect.poll(() => scroller.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(96);
    await scroller.evaluate((element, duringResize) => {
      const state = window as Window & { __appendSyntheticChatStream?: () => void; __detachOnNextChatResize?: boolean };
      if (duringResize) state.__detachOnNextChatResize = true;
      else {
        element.scrollTop = 0;
        element.dispatchEvent(new Event("scroll", { bubbles: true }));
      }
      if (!state.__appendSyntheticChatStream) throw new Error("synthetic stream append missing");
      state.__appendSyntheticChatStream();
    }, detachDuringResize);
    await expect(page.getByRole("button", { name: "Volver al final" })).toBeVisible();
    await expect(page.getByText("Segundo fragmento que debe respetar la lectura.", { exact: false })).toBeVisible();
    expect(await scroller.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(1);

    await expect(page.getByRole("button", { name: "Detener respuesta" })).toBeVisible();
    await page.getByRole("button", { name: "Volver al final" }).click();
    await expect.poll(() => scroller.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(96);

    await page.evaluate(() => {
      const finish = (window as Window & { __finishSyntheticChatStream?: () => void }).__finishSyntheticChatStream;
      if (!finish) throw new Error("synthetic chat stream is not active");
      finish();
    });
    await expect(page.getByRole("button", { name: "Enviar mensaje" })).toBeVisible();
    await expect.poll(() => scroller.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(96);
  });
}
