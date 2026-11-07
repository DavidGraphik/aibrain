import { expect, type Page } from "@playwright/test";

/** Reload now opens home. Continuity checks explicitly reopen their conversation. */
export async function reloadAndReopenConversation(page: Page) {
  const title = await page.evaluate(() => {
    const previewKey = Object.keys(localStorage).find(key => key.endsWith(".workbench.preview.v1"));
    if (!previewKey) throw new Error("Preview workbench missing");
    const snapshot = JSON.parse(localStorage.getItem(previewKey)!);
    const selection = JSON.parse(localStorage.getItem(previewKey.replace("workbench.preview.v1", "selection.v1"))!);
    const threadId = selection.threadByProject[selection.activeProjectId];
    const thread = snapshot.threads.find((item: { id: string }) => item.id === threadId);
    if (!thread) throw new Error("Selected test conversation missing");
    return thread.title as string;
  });
  await page.reload();
  await expect(page.getByRole("main")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("article.flex.justify-end")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("combobox", { name: "Buscar proyectos y conversaciones" }).fill(title);
  await page.getByRole("option").filter({ hasText: title }).first().click();
}
