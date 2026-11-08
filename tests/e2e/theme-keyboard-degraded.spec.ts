import { enableRouteDrivenDemoWorkbench } from "../helpers/playwright-auth";
import { reloadAndReopenConversation } from "../helpers/reopen-conversation";
import { expect, test, type Page } from "@playwright/test";
const accountName = process.env.AIBRAIN_UI_INSTALLATION === "northwind-qa" ? "Taylor" : "Alex";
async function login(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: new RegExp(accountName) }).click();
  await expect(page.getByTestId("composer")).toBeVisible();
}

test("system theme follows the OS and reduced motion removes decorative animation", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript(() => localStorage.removeItem("aibrain:theme"));
  await login(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveClass(/dark/);

  await page.getByRole("button", { name: new RegExp(`${accountName}.*Abrir menú de cuenta`) }).click();
  await page.getByRole("menuitem", { name: "Configuración" }).click();
  await expect(page.getByRole("dialog", { name: /Configuración de/ })).toBeVisible();
  await page.getByRole("button", { name: /Tema del sistema/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: /Tema claro/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: /Tema oscuro/ }).click();
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("html")).not.toHaveClass(/dark/);

  const animationDuration = await page.evaluate(() => {
    const node = document.createElement("div");
    node.className = "message-enter";
    document.body.append(node);
    const duration = getComputedStyle(node).animationDuration;
    node.remove();
    return duration;
  });
  expect(Number.parseFloat(animationDuration)).toBeLessThanOrEqual(0.00001);

  await page.addInitScript(() => {
    const original = Element.prototype.scrollIntoView;
    Object.defineProperty(window, "__reducedScrollBehaviors", { value: [] as string[], configurable: true });
    Element.prototype.scrollIntoView = function scrollIntoView(options?: boolean | ScrollIntoViewOptions) {
      if (typeof options === "object" && options.behavior) {
        (window as typeof window & { __reducedScrollBehaviors: string[] }).__reducedScrollBehaviors.push(options.behavior);
      }
      return original.call(this, options);
    };
  });
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
      title: "Movimiento reducido sintético",
      status: "active",
      pinned: false,
      createdAt: now,
      updatedAt: now,
      messages: Array.from({ length: 40 }, (_, index) => ({
        id: crypto.randomUUID(), role: index % 2 ? "assistant" : "user",
        content: `Mensaje ${index + 1}: contenido sintético para crear una conversación larga.`,
        createdAt: new Date(Date.now() + index).toISOString(), status: "complete",
        activity: [], plan: [], approvals: [], diff: "", attachments: [], artifacts: [],
      })),
    });
    localStorage.setItem(previewKey, JSON.stringify(snapshot));
    const prefix = previewKey.slice(0, -"workbench.preview.v1".length);
    localStorage.setItem(`${prefix}selection.v1`, JSON.stringify({ activeProjectId: project.id, threadByProject: { [project.id]: threadId } }));
  });
  await reloadAndReopenConversation(page);
  const scroller = page.locator(".workbench-main > .scrollbar-thin");
  // Wait for the recovered thread, not just the shell left during hydration.
  await expect(page.getByText("Mensaje 40:", { exact: false })).toBeVisible();
  await expect.poll(() => scroller.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(96);
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.getByRole("button", { name: "Volver al final" }).click();
  // Instant following may assign scrollTop instead of calling scrollIntoView.
  // Assert visible arrival within two paints, not an obsolete API call.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await page.evaluate(() => (window as typeof window & { __reducedScrollBehaviors: string[] }).__reducedScrollBehaviors)).not.toContain("smooth");
  expect(await scroller.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(96);
});

test("keyboard dialogs trap focus, close with Escape and restore their opener", async ({ page }) => {
  await login(page);
  const searchTrigger = page.getByRole("button", { name: "Buscar" });
  await searchTrigger.click();
  const palette = page.getByRole("dialog", { name: "Buscar proyectos y conversaciones" });
  const search = page.getByRole("combobox", { name: "Buscar proyectos y conversaciones" });
  await expect(search).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(search).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  await expect(searchTrigger).toBeFocused();
});

test("global shortcuts never stack modal surfaces or hijack an editor", async ({ page }) => {
  await login(page);
  const accountButton = page.getByRole("button", { name: new RegExp(`${accountName}.*Abrir menú de cuenta`) });
  await accountButton.click();
  await page.getByRole("menu", { name: "Cuenta y preferencias" }).getByRole("menuitem", { name: "Configuración" }).click();
  const preferences = page.getByRole("dialog", { name: new RegExp("Configuración de") });
  await expect(preferences).toBeVisible();

  await page.keyboard.press("Meta+K");
  await page.keyboard.press("Meta+Alt+U");
  await expect(preferences).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Buscar proyectos y conversaciones" })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Centro de tareas" })).toHaveCount(0);
  await expect(page.locator('[role="dialog"][aria-modal="true"]')).toHaveCount(1);

  await page.keyboard.press("Escape");
  await expect(accountButton).toBeFocused();
  const editor = page.getByRole("textbox", { name: "Mensaje" });
  await editor.focus();
  await page.keyboard.press("Meta+Alt+U");
  await expect(editor).toBeFocused();
  await expect(page.getByRole("dialog", { name: "Centro de tareas" })).toHaveCount(0);

  await editor.fill("Borrador conservado");
  await page.keyboard.press("Meta+K");
  const palette = page.getByRole("dialog", { name: "Buscar proyectos y conversaciones" });
  await expect(palette).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", {
    key: "k", code: "KeyK", metaKey: true, repeat: true, bubbles: true,
  })));
  await expect(palette).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue("Borrador conservado");

  await page.keyboard.press("Meta+Shift+P");
  await expect(page.getByRole("heading", { name: "Nuevo proyecto" })).toHaveCount(0);
});

test("resizing a desktop review beside a palette leaves a single modal owner", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const events = [
    { type: "diff", value: "diff --git a/estado.txt b/estado.txt\n--- a/estado.txt\n+++ b/estado.txt\n@@ -1 +1 @@\n-Pendiente\n+Completado" },
    { type: "delta", value: "## Resultado para redimensionar\n\nListo para revisar." },
    { type: "done" },
  ];
  await page.route("**/api/chat", (route) => route.fulfill({
    status: 200,
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
    body: `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  }));
  await login(page);
  await page.getByRole("textbox", { name: "Mensaje" }).fill("Prepara una revisión para redimensionar.");
  await page.getByRole("button", { name: "Enviar mensaje" }).click();
  await expect(page.getByRole("heading", { name: "Resultado para redimensionar" })).toBeVisible();
  await page.getByRole("button", { name: "Abrir cambios y resultados" }).click();
  const review = page.locator('aside[aria-label="Cambios y resultados del turno"]');
  await expect(review).toBeVisible();
  await page.keyboard.press("Meta+K");
  const palette = page.getByRole("dialog", { name: "Buscar proyectos y conversaciones" });
  await expect(palette).toBeVisible();
  await expect(page.locator('[aria-modal="true"]')).toHaveCount(1);

  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(review).toHaveCount(0);
  await expect(palette).toBeVisible();
  await expect(page.locator('[aria-modal="true"]')).toHaveCount(1);
});

test("desktop notification clicks never stack Task Center over a blocking surface", async ({ page }) => {
  await enableRouteDrivenDemoWorkbench(page);
  await page.addInitScript(() => {
    class SyntheticNotification {
      static permission: NotificationPermission = "granted";
      static requestPermission = async () => "granted" as NotificationPermission;
      onclick: (() => void) | null = null;
      closed = false;

      constructor(readonly title: string, readonly options?: NotificationOptions) {
        const target = window as typeof window & { __syntheticNotifications?: SyntheticNotification[] };
        target.__syntheticNotifications ??= [];
        target.__syntheticNotifications.push(this);
      }

      close() {
        this.closed = true;
      }
    }
    Object.defineProperty(window, "Notification", { configurable: true, value: SyntheticNotification });
  });

  await login(page);

  const firstThreadId = "018f5f68-4a6e-7abc-8def-012345678911";
  const firstMessageId = "018f5f68-4a6e-7abc-8def-012345678912";
  const secondThreadId = "018f5f68-4a6e-7abc-8def-012345678921";
  const secondMessageId = "018f5f68-4a6e-7abc-8def-012345678922";
  const task = (threadId: string, messageId: string, status: "running" | "completed") => ({
    id: `${threadId}.${messageId}`,
    threadId,
    projectId: "018f5f68-4a6e-7abc-8def-0123456789ab",
    threadTitle: status === "running" ? "Tarea sintética en curso" : "Tarea sintética completada",
    projectName: "Trabajo interno",
    status,
    title: status === "running" ? "Trabajando en tu solicitud" : "Resultado preparado",
    detail: status === "running" ? "La respuesta continúa." : "El resultado ya está disponible.",
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: status === "running" ? "2026-08-30T10:00:00.000Z" : "2026-08-30T10:00:01.000Z",
    unread: status === "completed",
  });
  let taskStage = 0;
  await page.route("**/api/task-center", (route) => {
    const stage = taskStage;
    const tasks = stage === 0
      ? [task(firstThreadId, firstMessageId, "running")]
      : stage === 1
        ? [task(firstThreadId, firstMessageId, "completed")]
        : stage === 2
          ? [task(firstThreadId, firstMessageId, "completed"), task(secondThreadId, secondMessageId, "running")]
          : [task(firstThreadId, firstMessageId, "completed"), task(secondThreadId, secondMessageId, "completed")];
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        tasks,
        readTaskIds: [],
        preferences: { inApp: true, desktop: true },
        continuity: "worker_required",
      }),
    });
  });

  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean((window as typeof window & { __rewroteWorkbenchPersistence?: boolean }).__rewroteWorkbenchPersistence))).toBe(true);
  await expect(page.getByTestId("composer")).toBeVisible();
  const accountButton = page.getByRole("button", { name: new RegExp(`${accountName}.*Abrir menú de cuenta`) });
  // Commit the initial running snapshot before opening the blocking surface.
  // Keep focus outside the composer, where global shortcuts are disabled.
  await accountButton.focus();
  await page.keyboard.press("Meta+Alt+U");
  const initialTaskCenter = page.getByRole("dialog", { name: "Centro de tareas" });
  await expect(initialTaskCenter).toBeVisible();
  await expect(initialTaskCenter.getByRole("article")).toHaveCount(1);
  await expect(initialTaskCenter.getByRole("heading", { name: "Trabajando en tu solicitud", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(initialTaskCenter).toBeHidden();
  await accountButton.click();
  await page.getByRole("menu", { name: "Cuenta y preferencias" }).getByRole("menuitem", { name: "Configuración" }).click();
  const preferences = page.getByRole("dialog", { name: new RegExp("Configuración de") });
  await expect(preferences).toBeVisible();

  taskStage = 1;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __syntheticNotifications?: unknown[] }).__syntheticNotifications?.length ?? 0)).toBe(1);
  await page.evaluate(() => {
    const notifications = (window as typeof window & { __syntheticNotifications: Array<{ onclick: (() => void) | null }> }).__syntheticNotifications;
    notifications.at(-1)?.onclick?.();
  });
  await expect(preferences).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Centro de tareas" })).toHaveCount(0);
  await expect(page.locator('[role="dialog"][aria-modal="true"]')).toHaveCount(1);

  await page.keyboard.press("Escape");
  await expect(preferences).toBeHidden();
  taskStage = 2;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  // A route hit precedes JSON consumption and the polling gate's finally.
  // Observe the committed stage-2 UI before sending the next focus event;
  // otherwise that event is correctly coalesced with the still-active poll.
  // Reuse the notification action once the blocking preferences dialog has
  // closed. Focus can now be in the composer, where the global shortcut is
  // intentionally ignored to preserve editing.
  await page.evaluate(() => {
    const notifications = (window as typeof window & { __syntheticNotifications: Array<{ onclick: (() => void) | null }> }).__syntheticNotifications;
    notifications[0]?.onclick?.();
  });
  const taskCenter = page.getByRole("dialog", { name: "Centro de tareas" });
  await expect(taskCenter).toBeVisible();
  await expect(taskCenter.getByRole("article")).toHaveCount(2);
  await expect(taskCenter.getByRole("heading", { name: "Trabajando en tu solicitud", exact: true })).toBeVisible();
  await expect(taskCenter.getByRole("heading", { name: "Resultado preparado", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(taskCenter).toBeHidden();
  taskStage = 3;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __syntheticNotifications?: unknown[] }).__syntheticNotifications?.length ?? 0)).toBe(2);
  await page.evaluate(() => {
    const notifications = (window as typeof window & { __syntheticNotifications: Array<{ onclick: (() => void) | null }> }).__syntheticNotifications;
    notifications.at(-1)?.onclick?.();
  });
  await expect(page.getByRole("dialog", { name: "Centro de tareas" })).toBeVisible();
  await expect(page.locator('[role="dialog"][aria-modal="true"]')).toHaveCount(1);
  await page.evaluate(() => {
    const notifications = (window as typeof window & { __syntheticNotifications: Array<{ onclick: (() => void) | null }> }).__syntheticNotifications;
    notifications.at(-1)?.onclick?.();
  });
  await expect(page.getByRole("dialog", { name: "Centro de tareas" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Centro de tareas" })).toBeHidden();
  await page.waitForTimeout(150);
  await expect(page.getByRole("dialog", { name: "Centro de tareas" })).toBeHidden();
});

test("mobile completed responses expose only the copy action", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const events = [
    { type: "diff", value: "diff --git a/estado.txt b/estado.txt\n--- a/estado.txt\n+++ b/estado.txt\n@@ -1 +1 @@\n-Pendiente\n+Completado" },
    { type: "delta", value: "## Resultado sintético\n\nListo para revisar." },
    { type: "done" },
  ];
  await page.route("**/api/chat", (route) => route.fulfill({
    status: 200,
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
    body: `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  }));
  await login(page);
  await page.getByRole("textbox", { name: "Mensaje" }).fill("Prepara un cambio sintético.");
  await page.getByRole("button", { name: "Enviar mensaje" }).click();
  await expect(page.getByRole("heading", { name: "Resultado sintético" })).toBeVisible();

  const copy = page.getByRole("button", { name: "Copiar" });
  await expect(copy).toBeVisible();
  await expect(page.getByRole("button", { name: "Revisar resultados" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Aprobar resultado|Descargar resultado|Leer en voz alta|Regenerar respuesta|Crear rama/ })).toHaveCount(0);
});

test("runtime failures and offline state fail closed and recover explicitly", async ({ page, context }) => {
  let requests = 0;
  const status = {
    tenantId: "example-lab-dev",
    projectId: "018f5f68-4a6e-7abc-8def-0123456789ab",
    projectName: "Trabajo interno",
    mode: "demo",
    codex: "disabled",
    isolated: true,
    ready: true,
    authMode: null,
    planType: null,
    processWarm: false,
    rateLimit: null,
    usage: null,
    workspaceName: "workspace",
    model: null,
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    models: [],
    skills: [],
    capabilities: { webSearch: false, imageInput: true, imageGeneration: false },
  };
  await page.route("**/api/runtime/status**", (route) => {
    requests += 1;
    return requests === 1
      ? route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"synthetic"}' })
      : route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(status) });
  });
  await login(page);
  await expect(page.getByText("El servicio no está disponible. Puedes revisar el historial.")).toBeVisible();
  await page.getByRole("textbox", { name: "Mensaje" }).fill("No enviar todavía");
  await expect(page.getByRole("button", { name: "Enviar mensaje" })).toBeDisabled();
  await page.getByRole("button", { name: "Reintentar" }).click();
  await expect(page.getByRole("button", { name: "Enviar mensaje" })).toBeEnabled();

  await context.setOffline(true);
  await expect(page.getByText("Sin conexión. El historial sigue disponible y no se enviará nada.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Enviar mensaje" })).toBeDisabled();
  await context.setOffline(false);
  await expect(page.getByText("Sin conexión")).toBeHidden();
  await expect(page.getByRole("button", { name: "Enviar mensaje" })).toBeEnabled();
});

test("a successful runtime check cancels its unavailable deadline", async ({ page }) => {
  await page.addInitScript(() => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
      nativeSetTimeout(handler, timeout === 40_000 ? 1_000 : timeout, ...args)) as typeof window.setTimeout;
  });
  await page.route("**/api/runtime/status**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      tenantId: "example-lab-dev",
      projectId: "018f5f68-4a6e-7abc-8def-0123456789ab",
      projectName: "Trabajo interno",
      mode: "demo",
      codex: "disabled",
      isolated: true,
      ready: true,
      authMode: null,
      planType: null,
      processWarm: false,
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

  await login(page);
  await page.waitForTimeout(1_200);
  await expect(page.getByText("El servicio no está disponible. Puedes revisar el historial.")).toHaveCount(0);
  await page.getByRole("textbox", { name: "Mensaje" }).fill("Comprobar disponibilidad");
  await expect(page.getByRole("button", { name: "Enviar mensaje" })).toBeEnabled();
});
