import { reloadAndReopenConversation } from "../helpers/reopen-conversation";
import { expect, test } from "@playwright/test";
import { establishDemoSession } from "../helpers/playwright-auth";

const threadId = "018f5f68-4a6e-7abc-8def-0123456789ab";
const attachment = { id: "018f5f68-4a6e-7abc-8def-0123456789ac", name: "informe.pdf", mimeType: "application/pdf", size: 2048 };
const versionId = "018f5f68-4a6e-7abc-8def-0123456789ad";

for (const available of [true, false]) {
  test(`failed request keeps its original document and requires review (${available ? "available" : "missing"})`, async ({ page }) => {
    const turns: unknown[] = [];
    await page.route("**/api/chat", async (route) => {
      turns.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, contentType: "application/x-ndjson", body: JSON.stringify({ type: "done" }) + "\n" });
    });
    await page.route(`**/api/threads/${threadId}/documents/${attachment.id}`, (route) => route.fulfill({
      status: available ? 200 : 404, contentType: "application/json",
      body: JSON.stringify({ document: { documentId: attachment.id, threadId, originalVersionId: versionId,
        versions: [{ versionId, fileName: attachment.name, kind: "pdf", mediaType: attachment.mimeType, size: attachment.size,
          previewUrl: `/api/threads/${threadId}/documents/${attachment.id}/versions/${versionId}/preview/document.pdf` }] } }),
    }));
    await establishDemoSession(page, "example-user");
    await page.waitForFunction(() => Object.keys(localStorage).some((key) => key.endsWith(".workbench.preview.v1")));
    await page.evaluate(({ threadId, attachment }) => {
      const key = Object.keys(localStorage).find((key) => key.endsWith(".workbench.preview.v1"))!;
      const snapshot = JSON.parse(localStorage.getItem(key)!);
      const project = snapshot.projects[0];
      const now = new Date().toISOString();
      const base = { createdAt: now, activity: [], plan: [], approvals: [], diff: "", artifacts: [] };
      snapshot.threads.unshift({ id: threadId, projectId: project.id, title: "Recuperación de prueba", status: "active", pinned: false, createdAt: now, updatedAt: now,
        messages: [
          { ...base, id: crypto.randomUUID(), role: "user", content: "Revisa el informe original.", status: "complete", attachments: [attachment] },
          { ...base, id: crypto.randomUUID(), role: "assistant", content: "Resultado parcial conservado.", status: "error", attachments: [] },
        ] });
      localStorage.setItem(key, JSON.stringify(snapshot));
      localStorage.setItem(key.slice(0, -"workbench.preview.v1".length) + "selection.v1", JSON.stringify({ activeProjectId: project.id, threadByProject: { [project.id]: threadId } }));
    }, { threadId, attachment });
    await reloadAndReopenConversation(page);
    await page.getByRole("button", { name: "Editar solicitud" }).click();
    const composer = page.getByRole("textbox", { name: "Mensaje" });
    await expect(composer).toHaveValue("Revisa el informe original.");
    await expect(page.getByText("Resultado parcial conservado.", { exact: true })).toBeVisible();
    expect(turns).toHaveLength(0);
    const send = page.getByRole("button", { name: "Enviar mensaje" });
    if (!available) {
      await expect(send).toBeDisabled();
      await composer.press("Enter");
      expect(turns).toHaveLength(0);
      await expect(page.getByRole("alert").filter({ hasText: "Hay archivos no disponibles" })).toBeVisible();
      return;
    }
    await expect(send).toBeEnabled();
    await send.click();
    await expect.poll(() => turns.length).toBe(1);
    expect(turns[0]).toMatchObject({ threadId, message: "Revisa el informe original.", options: expect.objectContaining({ documentUploadIds: [attachment.id] }) });
  });
}
