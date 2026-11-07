// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "../render-spanish";
import { afterEach, describe, expect, it, vi } from "vitest";
import sidebarStyles from "@/components/sidebar.module.css";
import { Sidebar } from "@/components/sidebar";
import type { AuthSession } from "@/auth/types";
import type { PublicInstallationBranding } from "@/config/installation-branding";
import type { WorkbenchProject, WorkbenchThread } from "@/workbench/types";
import { STANDALONE_PROJECT_SLUG } from "@/workbench/types";
import type { ThreadActivity } from "@/workbench/thread-activity";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/ui/primitives", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/components/ui/primitives")>();
  return { ...original, ThemeToggle: () => <button type="button">Cambiar tema</button> };
});

const branding: PublicInstallationBranding = {
  installationId: "acme",
  companyName: "Acme",
  companySlug: "acme",
  publicUrl: "https://acme.example.com",
  productName: "AiBrain",
  logoPath: "/logo.svg",
  faviconPath: "/favicon.svg",
  accentColor: "#000000",
};

const session: AuthSession = {
  provider: "local",
  user: { id: "user-1", name: "Ada Lovelace", email: "ada@example.com" },
  tenant: { id: "tenant-1", name: "Acme" },
  expiresAt: "2026-08-29T00:00:00.000Z",
};

function project(id: string, name: string, slug = name.toLocaleLowerCase()): WorkbenchProject {
  return {
    id,
    name,
    slug,
    status: "active",
    pinned: false,
    instructions: "",
    sources: [],
    memory: { enabled: true, notes: "", updatedAt: null },
    sharing: { visibility: "private", members: [] },
    workspace: { id: `workspace-${id}`, label: name, hostType: "managed", status: "ready", isPrimary: true },
    createdAt: "2026-08-28T08:00:00.000Z",
    updatedAt: "2026-08-28T08:00:00.000Z",
  };
}

function thread(id: string, projectId: string, title: string): WorkbenchThread {
  return {
    id,
    projectId,
    title,
    status: "active",
    pinned: false,
    createdAt: "2026-08-28T08:00:00.000Z",
    updatedAt: "2026-08-28T08:00:00.000Z",
    messages: [],
  };
}

function renderSidebar(running = false, pinnedIds: string[] = [], extraThreads: WorkbenchThread[] = [], extraActivities: Record<string, ThreadActivity> = {}, cms?: { session: AuthSession; installationId: string; authorized: boolean }) {
  const onNewThread = vi.fn();
  const onSelectThread = vi.fn();
  const onThreadAction = vi.fn();
  const onOpenCommandPalette = vi.fn();
  const onOpenAutomations = vi.fn();
  const onOpenCustomization = vi.fn();
  const operations = project("project-operations", "Operaciones");
  const product = project("project-product", "Producto");
  const standalone = project("project-standalone", "Chats", STANDALONE_PROJECT_SLUG);

  const allThreads = [
    thread("thread-plan", operations.id, "Plan semanal"),
    thread("thread-roadmap", product.id, "Roadmap"),
    thread("thread-personal", standalone.id, "Recordatorio personal"),
    ...extraThreads,
  ];
  const orderedThreads = [
    ...pinnedIds.map((id) => allThreads.find((candidate) => candidate.id === id)).filter((candidate): candidate is WorkbenchThread => Boolean(candidate)),
    ...allThreads.filter((candidate) => !pinnedIds.includes(candidate.id)),
  ].map((candidate) => ({ ...candidate, pinned: pinnedIds.includes(candidate.id) }));

  render(
    <Sidebar
      branding={cms ? { ...branding, installationId: cms.installationId } : branding}
      session={cms?.session ?? session}
      insijetsWorkspaceAccess={cms?.authorized}
      onOpenCMS={cms ? vi.fn() : undefined}
      onOpenPriceIndex={cms ? vi.fn() : undefined}
      onOpenDirectory={cms ? vi.fn() : undefined}
      projects={[operations, product, standalone]}
      threads={orderedThreads}
      activeProjectId={operations.id}
      activeThreadId="thread-plan"
      mobileOpen={false}
      desktopOpen
      busy={false}
      threadActivityById={{ ...extraActivities, ...(running ? { "thread-plan": { state: "running", unreadCount: 0 } as ThreadActivity } : {}) }}
      onCloseMobile={vi.fn()}
      onCloseDesktop={vi.fn()}
      onOpenDesktop={vi.fn()}
      onOpenCommandPalette={onOpenCommandPalette}
      onOpenAutomations={onOpenAutomations}
      onSelectProject={vi.fn()}
      onSelectThread={onSelectThread}
      onNewThread={onNewThread}
      onNewProject={vi.fn()}
      onProjectAction={vi.fn()}
      onThreadAction={onThreadAction}
      onOpenCustomization={onOpenCustomization}
    />,
  );

  return { onNewThread, onSelectThread, onThreadAction, onOpenAutomations, onOpenCommandPalette, onOpenCustomization };
}

afterEach(() => { cleanup(); window.localStorage.clear(); vi.unstubAllGlobals(); });

describe("Sidebar", () => {
  it("opens archived conversations directly without hiding them in the account menu", () => {
    const { onOpenCustomization } = renderSidebar();
    const shortcut = screen.getByRole("button", { name: "Conversaciones archivadas" });
    fireEvent.click(shortcut);
    expect(onOpenCustomization).toHaveBeenCalledWith(shortcut, "archived");
  });

  it("lets an empty conversation be removed through its own contextual menu", () => {
    const { onThreadAction } = renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "Acciones de Recordatorio personal" }));
    const menu = screen.getByRole("menu", { name: "Acciones de Recordatorio personal" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Eliminar de la lista" }));
    expect(onThreadAction).toHaveBeenCalledWith(expect.objectContaining({ id: "thread-personal", messages: [] }), "remove", expect.anything());
  });

  it("remembers manual project disclosure across remounts", () => {
    renderSidebar();
    expect(screen.queryByRole("button", { name: "Roadmap" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expandir Producto" }));
    cleanup();
    renderSidebar();
    expect(screen.getByRole("button", { name: "Roadmap" })).toBeInTheDocument();
  });

  it("limits recent conversations and reveals the rest without removing them", () => {
    renderSidebar(false, [], Array.from({ length: 12 }, (_, i) => thread(`extra-${i}`, "project-standalone", `Recent ${i}`)));
    const list = screen.getByRole("region", { name: "Conversaciones recientes" });
    expect(within(list).queryByRole("button", { name: "Recent 11" })).not.toBeInTheDocument();
    fireEvent.click(within(list).getByRole("button", { name: "Ver más conversaciones" }));
    expect(within(list).getByRole("button", { name: "Recent 11" })).toBeInTheDocument();
  });

  it("bounds a large unread automation history while keeping the selected chat and approvals visible", () => {
    const history = Array.from({ length: 1_000 }, (_, i) => ({
      ...thread(`automation-${i}`, "project-operations", `Automation ${i}`),
      updatedAt: "2026-08-29T08:00:00.000Z",
    }));
    const approval = thread("old-approval", "project-operations", "Pending exact approval");
    const activities = Object.fromEntries(history.map((item) => [item.id, { state: "completed", unreadCount: 1 } as ThreadActivity]));
    activities[approval.id] = { state: "needs_attention", unreadCount: 1 };
    renderSidebar(true, [], [...history, approval], activities);
    const list = screen.getByLabelText("Chats de Operaciones");
    expect(within(list).getAllByTestId("sidebar-project-thread")).toHaveLength(22);
    expect(within(list).getByRole("button", { name: /^Plan semanal/ })).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: /^Pending exact approval/ })).toBeInTheDocument();
    expect(within(list).queryByText("Automation 999")).not.toBeInTheDocument();
    fireEvent.click(within(list).getByRole("button", { name: "Ver más conversaciones · Operaciones" }));
    expect(within(list).getAllByTestId("sidebar-project-thread")).toHaveLength(42);
    expect(within(list).getByText("Automation 39")).toBeInTheDocument();
  });

  it("reveals older project conversations independently for each project", () => {
    const history = ["operations", "product"].flatMap((name) => Array.from({ length: 50 }, (_, i) => ({
      ...thread(`${name}-${i}`, `project-${name}`, `${name} ${i}`),
      updatedAt: "2026-08-29T08:00:00.000Z",
    })));
    const { onSelectThread } = renderSidebar(false, [], history);
    fireEvent.click(screen.getByRole("button", { name: "Expandir Producto" }));
    const operations = screen.getByLabelText("Chats de Operaciones");
    const product = screen.getByLabelText("Chats de Producto");
    fireEvent.click(within(operations).getByRole("button", { name: "Ver más conversaciones · Operaciones" }));
    expect(within(operations).getByText("operations 39")).toBeInTheDocument();
    expect(within(product).queryByText("product 39")).not.toBeInTheDocument();
    fireEvent.click(within(product).getByRole("button", { name: "Ver más conversaciones · Producto" }));
    fireEvent.click(within(product).getByRole("button", { name: "product 39" }));
    expect(onSelectThread).toHaveBeenCalledWith("product-39");
  });

  it("keeps navigation and new chats enabled while the selected chat works", () => {
    const { onNewThread, onSelectThread } = renderSidebar(true);
    fireEvent.click(screen.getByRole("button", { name: "Expandir Producto" }));
    const otherChat = screen.getByRole("button", { name: "Roadmap" });
    fireEvent.click(screen.getByRole("button", { name: "Acciones de Operaciones" }));
    const newChat = screen.getByRole("menuitem", { name: "Nueva conversación en Operaciones" });
    expect(otherChat).toBeEnabled();
    expect(newChat).toBeEnabled();
    fireEvent.click(newChat);
    fireEvent.click(otherChat);
    expect(onSelectThread).toHaveBeenCalledWith("thread-roadmap");
    expect(onNewThread).toHaveBeenCalledWith("project-operations");
  });

  it("keeps the primary navigation focused on conversations and automations", () => {
    const { onOpenAutomations, onOpenCommandPalette } = renderSidebar();
    const navigation = screen.getByRole("navigation", { name: "Navegación principal" });

    expect(within(navigation).getByRole("button", { name: /Nueva conversación/ })).toBeInTheDocument();
    const search = within(screen.getByTestId("sidebar-header")).getByRole("button", { name: "Buscar" });
    expect(search).toHaveAttribute("title", "Buscar");
    expect(within(navigation).queryByRole("button", { name: "Buscar" })).not.toBeInTheDocument();
    fireEvent.click(search);
    fireEvent.click(within(navigation).getByRole("button", { name: "Automatizaciones" }));
    expect(onOpenCommandPalette).toHaveBeenCalledOnce();
    expect(onOpenAutomations).toHaveBeenCalledOnce();
    expect(within(navigation).queryByText("Biblioteca")).not.toBeInTheDocument();
    expect(within(navigation).queryByText("Centro de tareas")).not.toBeInTheDocument();
    expect(within(navigation).queryByText("⌘K")).not.toBeInTheDocument();
    expect(within(navigation).queryByText("Buscar")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abrir preferencias" })).not.toBeInTheDocument();
  });

  it("offers contextual help from the account menu", () => {
    renderSidebar();

    const account = screen.getByRole("button", { name: /Abrir menú de cuenta/ });
    fireEvent.click(account);
    fireEvent.click(screen.getByRole("menuitem", { name: "Ayuda" }));

    const dialog = screen.getByRole("dialog", { name: "Ayuda y feedback" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bug" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ayuda" })).toBeInTheDocument();
    expect(screen.queryByRole("menu", { name: "Cuenta y preferencias" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    expect(account).toHaveFocus();
  });

  it("opens support responses from the notice while keeping new-request drafts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ requests: [{
      id: "synthetic-request", description: "Synthetic support issue", status: "resolved", screenshots: [],
      messages: [{ id: "synthetic-response", author: "support", body: "Synthetic response is available", createdAt: "2026-11-05T08:00:00Z" }],
    }] })));
    renderSidebar();
    // The notice must open history even on the first opening.
    fireEvent.click(await screen.findByRole("status", { name: "Tienes una respuesta de soporte" }));
    expect(screen.getByRole("button", { name: "Nueva solicitud" })).toHaveAttribute("aria-pressed", "false");
    expect(await screen.findByRole("button", { name: "Mis solicitudes (1)" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("textbox", { name: "Descripción" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resuelta. Synthetic support issue" }));
    expect(screen.getByText("Synthetic response is available")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Nueva solicitud" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Descripción" }), { target: { value: "Synthetic unsent draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    fireEvent.click(screen.getByRole("button", { name: /Abrir menú de cuenta/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Ayuda" }));
    expect(screen.getByRole("textbox", { name: "Descripción" })).toHaveValue("Synthetic unsent draft");
  });

  it("closes the account menu when Escape arrives before focus enters it", async () => {
    renderSidebar();
    const account = screen.getByRole("button", { name: /Abrir menú de cuenta/ });
    fireEvent.click(account);
    fireEvent.keyDown(account, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Cuenta y preferencias" })).not.toBeInTheDocument();
    await waitFor(() => expect(account).toHaveFocus());
  });

  it("keeps the brand informational and gives account menus complete keyboard navigation", async () => {
    const { onNewThread, onOpenCustomization } = renderSidebar();
    const brand = screen.getByTestId("sidebar-brand");
    fireEvent.click(brand);
    expect(onNewThread).not.toHaveBeenCalled();
    expect(brand.closest("button")).toBeNull();

    const accountButton = screen.getByRole("button", { name: /Abrir menú de cuenta/ });
    expect(accountButton).toHaveAttribute("aria-haspopup", "menu");
    fireEvent.click(accountButton);
    const menu = screen.getByRole("menu", { name: "Cuenta y preferencias" });
    await waitFor(() => {
      expect(within(menu).getByRole("menuitem", { name: "Configuración" })).toHaveFocus();
    });
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(within(menu).getByRole("menuitem", { name: "Ayuda" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "End" });
    expect(within(menu).getByRole("menuitem", { name: "Cerrar sesión" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Home" });
    const settings = within(menu).getByRole("menuitem", { name: "Configuración" });
    expect(settings).toHaveFocus();
    fireEvent.click(settings);
    expect(onOpenCustomization).toHaveBeenCalledWith(accountButton);
  });

  it("nests every project chat below its project and keeps standalone chats separate", () => {
    const { onNewThread } = renderSidebar();
    const operationsChats = screen.getByLabelText("Chats de Operaciones");
    fireEvent.click(screen.getByRole("button", { name: "Expandir Producto" }));
    const productChats = screen.getByLabelText("Chats de Producto");
    const standaloneChats = screen.getByRole("region", { name: "Conversaciones recientes" });

    expect(within(operationsChats).getByRole("button", { name: "Plan semanal" })).toBeInTheDocument();
    expect(within(operationsChats).queryByText("Roadmap")).not.toBeInTheDocument();
    expect(within(productChats).getByRole("button", { name: "Roadmap" })).toBeInTheDocument();
    expect(within(standaloneChats).getByRole("button", { name: "Recordatorio personal" })).toBeInTheDocument();
    expect(within(standaloneChats).queryByText("Plan semanal")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Contraer Operaciones" })).toHaveClass("sidebar-project-disclosure");
    const operationsHeader = screen.getAllByTestId("sidebar-project-header")
      .find((header) => within(header).queryByRole("button", { name: "Operaciones" }));
    expect(operationsHeader).toBeDefined();
    expect(operationsHeader).not.toContainElement(operationsChats);

    fireEvent.click(screen.getByRole("button", { name: "Acciones de Operaciones" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Nueva conversación en Operaciones" }));
    fireEvent.click(screen.getByRole("button", { name: "Nueva conversación independiente" }));
    expect(onNewThread).toHaveBeenNthCalledWith(1, "project-operations");
    expect(onNewThread).toHaveBeenNthCalledWith(2);
  });

  it.each([false, true])("keeps one durable identity for a pinned chat while running=%s", (running) => {
    renderSidebar(running, ["thread-plan"]);
    const pinned = screen.getByRole("region", { name: "Anclados" });
    const identity = '[data-thread-id="thread-plan"]';
    expect(document.querySelectorAll(identity)).toHaveLength(1);
    const row = pinned.querySelector(identity);
    expect(row).toBeVisible();
    expect(row).toHaveTextContent("Plan semanal");
    if (running) expect(within(row as HTMLElement).getByLabelText("Trabajando")).toBeInTheDocument();
  });

  it("shows pinned chats once above projects and chats in their durable order", () => {
    const { onThreadAction } = renderSidebar(false, ["thread-personal", "thread-plan"]);
    const pinned = screen.getByRole("region", { name: "Anclados" });
    const chats = screen.getByRole("region", { name: "Conversaciones recientes" });
    const projects = screen.getByRole("region", { name: "Proyectos" });

    expect(projects.compareDocumentPosition(chats) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pinned.compareDocumentPosition(chats) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pinned.compareDocumentPosition(projects) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const firstPinned = within(pinned).getByRole("button", { name: "Recordatorio personal" });
    const secondPinned = within(pinned).getByRole("button", { name: "Plan semanal" });
    expect(firstPinned.compareDocumentPosition(secondPinned) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Recordatorio personal" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Plan semanal" })).toHaveLength(1);
    expect(within(chats).queryByRole("button", { name: "Recordatorio personal" })).not.toBeInTheDocument();
    expect(within(screen.getByLabelText("Chats de Operaciones")).queryByRole("button", { name: "Plan semanal" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Operaciones" })).toBeInTheDocument();

    fireEvent.click(within(pinned).getByRole("button", { name: "Acciones de Recordatorio personal" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Desfijar" }));
    expect(onThreadAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: "thread-personal", pinned: true }),
      "unpin",
      expect.anything(),
    );
  });

  it("gives projects and nested conversations distinct visual levels", () => {
    renderSidebar();
    expect(screen.getByTestId("sidebar-brand")).toHaveClass("px-2");
    expect(screen.getByTestId("sidebar-projects-label")).toHaveClass(sidebarStyles.sectionLabel);
    for (const row of screen.getAllByTestId("sidebar-project-row")) {
      expect(row).toHaveClass(sidebarStyles.projectRow);
    }
    expect(screen.getByLabelText("Chats de Operaciones")).toHaveClass(sidebarStyles.projectChildren);
  });

  it("shows only one contextual action trigger and manages menu focus", () => {
    renderSidebar();
    const sidebar = screen.getByTestId("workbench-sidebar");
    const trigger = screen.getByRole("button", { name: "Acciones de Recordatorio personal" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");

    trigger.focus();
    fireEvent.click(trigger);

    const menu = screen.getByRole("menu", { name: "Acciones de Recordatorio personal" });
    expect(sidebar).toHaveAttribute("data-context-menu-open", "true");
    expect(within(menu).getByRole("menuitem", { name: "Renombrar" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(within(menu).getByRole("menuitem", { name: "Fijar" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "End" });
    expect(within(menu).getByRole("menuitem", { name: "Archivar" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Home" });
    expect(within(menu).getByRole("menuitem", { name: "Renombrar" })).toHaveFocus();
    expect(trigger).not.toHaveClass("context-menu-suppressed");
    for (const other of screen.getAllByRole("button", { name: /Acciones de/ }).filter((button) => button !== trigger)) {
      expect(other).toHaveClass("context-menu-suppressed");
    }

    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Acciones de Recordatorio personal" })).not.toBeInTheDocument();
    expect(sidebar).toHaveAttribute("data-context-menu-open", "false");
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    const reopenedMenu = screen.getByRole("menu", { name: "Acciones de Recordatorio personal" });
    const outside = render(<button type="button">Fora del menú</button>).getByRole("button", { name: "Fora del menú" });
    fireEvent.pointerDown(outside);
    outside.focus();
    expect(reopenedMenu).not.toBeInTheDocument();
    expect(outside).toHaveFocus();
  });

  it("closes a menu on Tab without leaving menu items in the tab order", async () => {
    renderSidebar();
    const accountButton = screen.getByRole("button", { name: /Abrir menú de cuenta/ });
    fireEvent.click(accountButton);
    const menu = screen.getByRole("menu", { name: "Cuenta y preferencias" });
    const settings = within(menu).getByRole("menuitem", { name: "Configuración" });
    await waitFor(() => expect(settings).toHaveFocus());
    expect(settings).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(menu, { key: "Tab" });
    await waitFor(() => expect(menu).not.toBeInTheDocument());
    await waitFor(() => expect(accountButton).toHaveFocus());
  });
});

it("hides CMS while keeping Price Index and directory after Automations for the authorized InsiJets owner", () => {
  const owner: AuthSession = { ...session, user: { ...session.user, email: "cms-owner@example.invalid" }, tenant: { id: "insijets-demo", name: "InsiJets" }, expiresAt: new Date(Date.now() + 60000).toISOString() };
  renderSidebar(false, [], [], {}, { session: owner, installationId: "insijets-demo", authorized: true });
  const nav = screen.getByRole("navigation", { name: "Navegación principal" });
  expect(within(nav).queryByRole("button", { name: "Contenido de la web" })).not.toBeInTheDocument();
  const buttons = within(nav).getAllByRole("button");
  expect(buttons.at(-1)).toHaveAccessibleName("Directorio de operadores");
  expect(buttons.at(-2)).toHaveAccessibleName("Índice de precios");
  expect(buttons.at(-3)).toHaveAccessibleName("Automatizaciones");
  const compactNav = screen.getByTestId("workbench-sidebar-rail");
  expect(within(compactNav).queryByRole("button", { name: "Contenido de la web", hidden: true })).not.toBeInTheDocument();
});

it.each<[string, { installationId?: string; authorized?: boolean; tenant?: AuthSession["tenant"]; email?: string; expiresAt?: string }]>([
  ["installation mismatch", { installationId: "arnall" }],
  ["missing server permission", { authorized: false }],
  ["tenant mismatch", { tenant: { id: "other-tenant", name: "Other" } }],
  ["unapproved identity", { email: "someone@example.com" }],
  ["expired session", { expiresAt: "2020-01-01T00:00:00.000Z" }],
])("does not expose InsiJets workspace navigation with %s", (_reason, overrides) => {
  const owner: AuthSession = {
    ...session,
    user: { ...session.user, email: overrides.email ?? "cms-owner@example.invalid" },
    tenant: overrides.tenant ?? { id: "insijets-demo", name: "InsiJets" },
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60000).toISOString(),
  };
  renderSidebar(false, [], [], {}, {
    session: owner,
    installationId: overrides.installationId ?? "insijets-demo",
    authorized: overrides.authorized ?? true,
  });
  for (const name of ["Contenido de la web", "Índice de precios", "Directorio de operadores"]) {
    expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
  }
});
