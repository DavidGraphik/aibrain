import { reloadAndReopenConversation } from "../helpers/reopen-conversation";
import { expect, test, type Page } from "@playwright/test";
import type {
  ProjectMemberRole,
  WorkbenchProject,
  WorkbenchProjectAccess,
  WorkbenchSnapshot,
} from "@/workbench/types";

const accountName = process.env.AIBRAIN_UI_INSTALLATION === "northwind-qa" ? "Taylor" : "Alex";
const projectId = "018f5f68-4a6e-7abc-8def-0123456789a1";
const workspaceId = "018f5f68-4a6e-7abc-8def-0123456789a2";
const threadId = "018f5f68-4a6e-7abc-8def-0123456789a3";
const userMessageId = "018f5f68-4a6e-7abc-8def-0123456789a4";
const assistantMessageId = "018f5f68-4a6e-7abc-8def-0123456789a5";
const artifactId = "018f5f68-4a6e-7abc-8def-0123456789a6";
const memberId = "018f5f68-4a6e-7abc-8def-0123456789a7";
const standaloneProjectId = "018f5f68-4a6e-7abc-8def-0123456789a8";
const standaloneWorkspaceId = "018f5f68-4a6e-7abc-8def-0123456789a9";
const projectName = "Proyecto compartido verificado";
const documentName = "shared-notes.txt";
const previewText = "Contexto compartido verificable para lectura segura.";
const downloadUrl = `/api/projects/${projectId}/artifacts/${artifactId}`;
const previewUrl = `${downloadUrl}/preview/1`;

const viewports = [
  { label: "desktop", width: 1440, height: 900 },
  { label: "mobile-390", width: 390, height: 844 },
] as const;

const accessByRole: Record<"viewer" | "editor", WorkbenchProjectAccess> = {
  viewer: { role: "viewer", canEdit: false, canManage: false },
  editor: { role: "editor", canEdit: true, canManage: false },
};

function sharedSnapshot(role: "viewer" | "editor"): WorkbenchSnapshot {
  const now = "2026-08-30T08:00:00.000Z";
  const sharedProject: WorkbenchProject = {
    id: projectId,
    name: projectName,
    slug: "proyecto-compartido-verificado",
    status: "active",
    pinned: true,
    instructions: "Conserva el contexto compartido y revisa los cambios antes de publicarlos.",
    sources: [],
    memory: { enabled: true, notes: "Memoria compartida de solo contexto.", updatedAt: now },
    sharing: {
      visibility: "shared",
      members: [{
        id: memberId,
        email: "member@example.com",
        name: "Shared Member",
        // Deliberately differs from `access`: customer context must never become browser authorization.
        role: (role === "viewer" ? "editor" : "viewer") satisfies ProjectMemberRole,
        status: "active",
        addedAt: now,
      }],
    },
    access: accessByRole[role],
    workspace: {
      id: workspaceId,
      label: "Workspace compartido",
      hostType: "managed",
      status: "ready",
      isPrimary: true,
    },
    createdAt: now,
    updatedAt: "2026-08-30T08:10:00.000Z",
  };
  const standaloneProject: WorkbenchProject = {
    id: standaloneProjectId,
    name: "Conversaciones personales",
    slug: "aibrain-standalone-chats",
    status: "active",
    pinned: false,
    instructions: "",
    sources: [],
    memory: { enabled: true, notes: "", updatedAt: null },
    sharing: { visibility: "private", members: [] },
    access: { role: "owner", canEdit: true, canManage: true },
    workspace: {
      id: standaloneWorkspaceId,
      label: "Personal",
      hostType: "managed",
      status: "ready",
      isPrimary: false,
    },
    createdAt: now,
    updatedAt: now,
  };

  return {
    persistence: "browser-preview",
    projects: [sharedProject, standaloneProject],
    threads: [{
      id: threadId,
      projectId,
      title: "Historial compartido",
      status: "active",
      pinned: true,
      createdAt: now,
      updatedAt: "2026-08-30T08:12:00.000Z",
      messages: [
        {
          id: userMessageId,
          role: "user",
          content: "Consulta histórica compartida que debe seguir visible.",
          createdAt: now,
          status: "complete",
          activity: [],
          plan: [],
          approvals: [],
          diff: "",
          attachments: [],
          artifacts: [],
        },
        {
          id: assistantMessageId,
          role: "assistant",
          content: "La respuesta histórica y su documento siguen disponibles.",
          createdAt: "2026-08-30T08:11:00.000Z",
          status: "complete",
          activity: [],
          plan: [],
          approvals: [{
            id: "approval-shared-permissions",
            threadId,
            turnId: assistantMessageId,
            itemId: "item-shared-permissions",
            kind: "file",
            title: "Aplicar cambio compartido",
            detail: "Este cambio sintético requiere autorización de escritura.",
            status: "pending",
          }],
          diff: "",
          attachments: [],
          artifacts: [{
            id: artifactId,
            type: "document",
            name: documentName,
            url: downloadUrl,
            kind: "text",
            mimeType: "text/plain",
            size: 58,
            status: "ready",
            pages: 1,
            previewUrl,
            publicationStatus: "awaiting_confirmation",
            publicationError: null,
            targetLabel: `knowledge/${documentName}`,
            error: null,
          }],
        },
      ],
    }],
  };
}

async function login(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: new RegExp(accountName) }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("composer")).toBeVisible();
}

async function seedSharedSnapshot(page: Page, role: "viewer" | "editor") {
  const snapshot = sharedSnapshot(role);
  await page.evaluate((nextSnapshot) => {
    const previewKey = Object.keys(localStorage).find((key) => key.endsWith(".workbench.preview.v1"));
    if (!previewKey) throw new Error("Preview workbench key missing");
    const prefix = previewKey.slice(0, -"workbench.preview.v1".length);
    localStorage.setItem(previewKey, JSON.stringify(nextSnapshot));
    localStorage.setItem(`${prefix}selection.v1`, JSON.stringify({
      activeProjectId: nextSnapshot.projects[0].id,
      threadByProject: { [nextSnapshot.projects[0].id]: nextSnapshot.threads[0].id },
    }));
  }, snapshot);
  await reloadAndReopenConversation(page);
  await expect(page.getByRole("heading", { name: "Historial compartido" })).toBeVisible();
}

async function installReadRoutesAndMutationGuard(page: Page) {
  const mutations: Array<{ method: string; path: string }> = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    if (["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      await route.fallback();
      return;
    }
    mutations.push({ method: request.method(), path: new URL(request.url()).pathname });
    await route.fulfill({
      status: 599,
      contentType: "application/json",
      body: JSON.stringify({ error: "Unexpected mutating request blocked by shared-permission test." }),
    });
  });
  await page.route(`**${previewUrl}`, (route) => route.fulfill({
    status: 200,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Length": String(new TextEncoder().encode(previewText).byteLength),
      "Content-Type": "text/plain; charset=utf-8",
    },
    body: previewText,
  }));
  await page.route(`**${downloadUrl}`, (route) => route.fulfill({
    status: 200,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="${documentName}"`,
      "Content-Length": String(new TextEncoder().encode(previewText).byteLength),
      "Content-Type": "text/plain; charset=utf-8",
    },
    body: previewText,
  }));
  return mutations;
}

async function verifyReadableHistoryAndArtifact(page: Page) {
  await expect(page.getByText("Consulta histórica compartida que debe seguir visible.")).toBeVisible();
  await expect(page.getByText("La respuesta histórica y su documento siguen disponibles.")).toBeVisible();
  await expect(page.getByText("Pendiente de confirmación segura")).toBeVisible();

  const downloadLink = page.getByRole("link", { name: `Descargar ${documentName}` });
  await expect(downloadLink).toHaveAttribute("href", downloadUrl);
  const downloaded = await page.evaluate(async (url) => {
    const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
    return {
      body: await response.text(),
      disposition: response.headers.get("Content-Disposition"),
      status: response.status,
    };
  }, downloadUrl);
  expect(downloaded).toEqual({
    body: previewText,
    disposition: `attachment; filename="${documentName}"`,
    status: 200,
  });

  await page.getByRole("button", { name: `Previsualizar ${documentName}` }).click();
  await expect(page.getByLabel(`Vista previa de ${documentName}`)).toBeVisible();
  await expect(page.getByLabel(`Documento ${documentName}`)).toContainText(previewText);
  await page.getByRole("button", { name: "Cerrar vista previa" }).click();
  await expect(page.getByLabel(`Vista previa de ${documentName}`)).toHaveCount(0);
}

async function openSharedProjectMenu(page: Page, mobile: boolean) {
  if (mobile) {
    await page.getByRole("button", { name: "Mostrar u ocultar la barra lateral" }).click();
    await expect(page.getByRole("dialog", { name: "Navegación" })).toBeVisible();
  }
  const projectButton = page.getByRole("button", { name: new RegExp(`^${projectName}`) });
  await projectButton.hover();
  const actions = page.getByRole("button", { name: `Acciones de ${projectName}` });
  await actions.click();
  const menu = page.getByRole("menu", { name: `Acciones de ${projectName}` });
  await expect(menu).toBeVisible();
  return menu;
}

async function verifyViewerSurface(page: Page, mobile: boolean) {
  await expect(page.getByText(/Conversación de solo lectura/)).toBeVisible();
  await expect(page.getByTestId("composer")).toHaveCount(0);
  await expect(page.getByRole("button", { name: `Nueva conversación en ${projectName}` })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Editar mensaje y crear una rama" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(?:Permitir|Durante esta tarea|Rechazar|Publicar|Preparar publicación)$/ })).toHaveCount(0);

  const menu = await openSharedProjectMenu(page, mobile);
  await expect(menu.getByRole("menuitem", { name: "Renombrar" })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: /^(?:Fijar|Desfijar)$/ })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "Archivar" })).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "Ajustes del proyecto" }).click();

  const dialog = page.getByRole("dialog", { name: "Configurar proyecto" });
  await expect(dialog.getByText(/Tienes acceso de solo lectura/)).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Instrucciones del proyecto" })).toHaveAttribute("readonly");
  await expect(dialog.getByRole("switch", { name: "Activar memoria del proyecto" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Guardar cambios" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Personas" }).click();
  await expect(dialog.getByRole("combobox", { name: "Visibilidad del proyecto" })).toBeDisabled();
  await expect(dialog.getByRole("combobox", { name: "Rol de member@example.com" })).toBeDisabled();
  await expect(dialog.getByRole("textbox", { name: "Correo de la persona" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Quitar member@example.com" })).toHaveCount(0);
}

async function verifyEditorSurface(page: Page, mobile: boolean) {
  await expect(page.getByTestId("composer")).toBeVisible();
  const menu = await openSharedProjectMenu(page, mobile);
  await expect(menu.getByRole("menuitem", { name: "Renombrar" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Archivar" })).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "Ajustes del proyecto" }).click();

  const dialog = page.getByRole("dialog", { name: "Configurar proyecto" });
  const instructions = dialog.getByRole("textbox", { name: "Instrucciones del proyecto" });
  const updatedContext = "Contexto actualizado por editor sin tocar compartición ni estado.";
  await instructions.fill(updatedContext);
  await dialog.getByRole("button", { name: "Personas" }).click();
  await expect(dialog.getByRole("combobox", { name: "Visibilidad del proyecto" })).toBeDisabled();
  await expect(dialog.getByRole("combobox", { name: "Rol de member@example.com" })).toBeDisabled();
  await expect(dialog.getByRole("textbox", { name: "Correo de la persona" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Quitar member@example.com" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(dialog.getByText("Proyecto actualizado.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Personas" })).toHaveAttribute("aria-current", "page");

  await expect.poll(() => page.evaluate(({ expectedProjectId }) => {
    const previewKey = Object.keys(localStorage).find((key) => key.endsWith(".workbench.preview.v1"));
    if (!previewKey) return null;
    const snapshot = JSON.parse(localStorage.getItem(previewKey) ?? "null") as WorkbenchSnapshot | null;
    return snapshot?.projects.find((project) => project.id === expectedProjectId)?.instructions ?? null;
  }, { expectedProjectId: projectId })).toBe(updatedContext);
  await dialog.getByRole("button", { name: "Contexto" }).click();
  await expect(dialog.getByRole("textbox", { name: "Instrucciones del proyecto" })).toHaveValue(updatedContext);
}

for (const role of ["viewer", "editor"] as const) {
  for (const viewport of viewports) {
    test(`${role} shared-project permissions hold on ${viewport.label}`, async ({ page }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await login(page);
      const mutations = await installReadRoutesAndMutationGuard(page);
      await seedSharedSnapshot(page, role);

      await verifyReadableHistoryAndArtifact(page);
      if (role === "viewer") await verifyViewerSurface(page, viewport.width < 768);
      else await verifyEditorSurface(page, viewport.width < 768);

      expect(mutations, "shared-project UI emitted an unexpected mutating API request").toEqual([]);
      expect(pageErrors).toEqual([]);
    });
  }
}
