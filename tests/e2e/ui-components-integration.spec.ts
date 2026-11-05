import { reloadAndReopenConversation } from "../helpers/reopen-conversation";
import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";

for (const [name, viewport] of Object.entries({ desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } })) {
  test(`integrated chat and sidebar ${name}`, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/login");
    await page.getByRole("button", { name: /Alex/ }).click();
    await expect(page.getByTestId("composer")).toBeVisible();
    await expect(page.locator('[data-slot="stars-background"]')).toHaveCount(0);
    const send = page.getByRole("button", { name: "Enviar mensaje", exact: true });
    await expect(send).toHaveClass(/composer-submit/);
    await expect(send).toHaveAttribute("type", "button");
    await expect(send).toBeDisabled();
    await page.getByTestId("composer").locator("textarea").fill("Prova visual del botó");
    await expect(send).toBeEnabled();
    await send.focus();
    expect(await send.evaluate((element) => getComputedStyle(element).backgroundImage)).toBe("none");
    await page.screenshot({ path: `.impeccable/review/landing-stars-${name}.png`, fullPage: true });
    const backdrop = await page.getByTestId("composer").evaluate((element) => ({
      filter: getComputedStyle(element).backdropFilter,
      opaque: matchMedia("(prefers-reduced-transparency: reduce), (prefers-contrast: more), (forced-colors: active)").matches,
    }));
    if (backdrop.opaque) expect(backdrop.filter).toBe("none");
    else expect(backdrop.filter).toBe("none");
    await page.evaluate(() => {
      const key = Object.keys(localStorage).find((key) => key.endsWith(".workbench.preview.v1"))!;
      const snapshot = JSON.parse(localStorage.getItem(key)!);
      const project = snapshot.projects[0];
      const id = crypto.randomUUID();
      const createdAt = "2026-09-02T10:00:00Z";
      const message = { id: crypto.randomUUID(), role: "assistant", createdAt, status: "complete", content: "**Revisión sintética de interfaz.** Las fuentes permanecen vinculadas a los documentos recibidos.", durationMs: 14000,
        activity: [{ id: "read", kind: "file", status: "complete", label: "Documento revisado", sequence: 1 }], plan: [], diff: "", attachments: [], artifacts: [],
        approvals: [{ id: "approval", threadId: id, turnId: "turn", itemId: "item", kind: "file", title: "Aplicar los cambios revisados", detail: "Ejemplo sintético de aprobación. No modifica archivos.", status: "pending" }],
        sources: [
          { id: "web", kind: "web", title: "Documentación de referencia", url: "https://example.com/reference", domain: "example.com", snippet: null, publishedAt: null },
          { id: "file", kind: "file", title: "Informe de revisión.pdf", url: null, domain: null, snippet: null, publishedAt: null },
        ],
        toolResults: [{ id: "tool", kind: "file", status: "complete", title: "Lectura del documento", summary: "Texto sintético", output: "Revisión disponible", sourceIds: ["file"], createdAt, sequence: 2 }],
      };
      snapshot.threads.unshift({ id, projectId: project.id, title: "Revisión sintética de componentes", createdAt, updatedAt: createdAt, status: "active", pinned: false, messages: [message] });
      localStorage.setItem(key, JSON.stringify(snapshot));
      const prefix = key.slice(0, -"workbench.preview.v1".length);
      localStorage.setItem(`${prefix}selection.v1`, JSON.stringify({ activeProjectId: project.id, threadByProject: { [project.id]: id } }));
    });
    await reloadAndReopenConversation(page);
    await expect(page.locator('[data-slot="stars-background"]')).toHaveCount(0);
    await expect(page.locator(".rg-button")).toHaveCount(0);
    await expect(page.locator('[data-slot="day-separator"]')).toBeVisible();
    await page.getByRole("button", { name: "Mostrar el proceso de trabajo" }).click();
    await page.getByText("Fuentes", { exact: true }).click();
    for (const slot of ["tool-timeline", "tool-call", "permission-grant", "web-search", "document-reference"]) await expect(page.locator(`[data-slot="${slot}"]`)).toBeVisible();
    await expect(page.locator('[data-slot="memory-chips"]')).toHaveCount(0);
    await page.locator(".workbench-main > .scrollbar-thin").evaluate((element) => { element.scrollTop = 0; });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await page.waitForTimeout(300);
    await mkdir(".impeccable/review", { recursive: true });
    await page.screenshot({ path: `.impeccable/review/integrated-${name}.png`, fullPage: true });
    if (name === "mobile") await page.getByRole("button", { name: "Mostrar u ocultar la barra lateral" }).click();
    const sidebar = page.getByTestId("workbench-sidebar");
    await expect(sidebar).toBeVisible();
    const panelGeometry = await sidebar.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, bottom: rect.bottom, radius: getComputedStyle(element).borderRadius };
    });
    // The Codex-style sidebar is flush to the viewport in both layouts.
    expect(panelGeometry).toEqual({ x: 0, y: 0, bottom: viewport.height, radius: "0px" });
    const newConversation = sidebar.getByRole("button", { name: "Nueva conversación", exact: true });
    expect(await newConversation.evaluate((element) => getComputedStyle(element).boxShadow)).toBe("none");
    await page.evaluate(() => document.fonts.ready);
    expect(await page.locator("body").evaluate((element) => getComputedStyle(element).fontFamily)).toContain("-apple-system");
    if (name === "mobile") await page.screenshot({ path: ".impeccable/review/integrated-mobile-sidebar.png", fullPage: true });
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    // Chat confirmation guidance remains readable in dark mode.
    const permissionCard = page.locator('[data-slot="permission-grant"]');
    await expect(permissionCard.getByRole("button")).toHaveCount(0);
    const approvalColors = await permissionCard.getByRole("status").evaluate((element) => {
      const style = getComputedStyle(element);
      return { foreground: style.color, background: getComputedStyle(element.closest('[data-slot="permission-grant"]')!).backgroundColor };
    });
    expect(approvalColors.foreground).not.toBe(approvalColors.background);
    await page.screenshot({ path: `.impeccable/review/integrated-${name}-dark.png`, fullPage: true });
    expect(pageErrors).toEqual([]);
  });
}
