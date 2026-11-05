import { expect, test } from "@playwright/test";
import { establishDemoSession } from "../helpers/playwright-auth";
import { reloadAndReopenConversation } from "../helpers/reopen-conversation";

for (const width of [390, 1440]) test(`refresh opens home and retains separate drafts and history at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  await establishDemoSession(page, "example-user");
  const input = page.getByRole("textbox", { name: "Mensaje", exact: true });
  await input.fill("Borrador de inicio");
  await expect.poll(() => page.evaluate(() => {
    const key = Object.keys(localStorage).find(key => key.endsWith(".composer-drafts.v1"));
    return key ? Object.values(JSON.parse(localStorage.getItem(key)!)) : [];
  })).toContain("Borrador de inicio");
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find(key => key.endsWith(".workbench.preview.v1"))!;
    const prefix = key.replace("workbench.preview.v1", "");
    const snapshot = JSON.parse(localStorage.getItem(key)!);
    const projectId = JSON.parse(localStorage.getItem(prefix + "selection.v1")!).activeProjectId;
    const threadId = crypto.randomUUID();
    const now = new Date().toISOString();
    snapshot.threads.unshift({ id: threadId, projectId, title: "Conversación conservada", status: "active", pinned: false, createdAt: now, updatedAt: now,
      messages: [{ id: crypto.randomUUID(), role: "user", content: "Historial conservado", status: "complete", createdAt: now, activity: [], plan: [], approvals: [], diff: "", artifacts: [], attachments: [] }] });
    localStorage.setItem(key, JSON.stringify(snapshot));
    localStorage.setItem(prefix + "selection.v1", JSON.stringify({ activeProjectId: projectId, threadByProject: { [projectId]: threadId } }));
    localStorage.setItem(prefix + "composer-drafts.v1", JSON.stringify({ ...JSON.parse(localStorage.getItem(prefix + "composer-drafts.v1")!), [`${projectId}:${threadId}`]: "Borrador del chat" }));
  });
  await page.reload();
  await expect(input).toHaveValue("Borrador de inicio");
  await expect(page.getByText("Historial conservado", { exact: true })).toHaveCount(0);
  await expect(page.locator('.landing-band')).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("combobox", { name: "Buscar proyectos y conversaciones" }).fill("Conversación conservada");
  await page.getByRole("option").filter({ hasText: "Conversación conservada" }).click();
  await expect(input).toHaveValue("Borrador del chat");
  await expect(page.getByText("Historial conservado", { exact: true })).toBeVisible();
  await input.fill("Borrador del chat actualizado");
  await reloadAndReopenConversation(page);
  await expect(input).toHaveValue("Borrador del chat actualizado");
  await expect(page.getByText("Historial conservado", { exact: true })).toBeVisible();
});
