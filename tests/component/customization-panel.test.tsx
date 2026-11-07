// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "../render-spanish";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CustomizationPanel } from "@/components/customization-panel";
import { UiLocaleProvider } from "@/i18n/provider";
import { ThemeProvider } from "@/components/theme-provider";
import { initialRuntimeStatus } from "@/lib/runtime-status";
import type { SettingsSnapshot } from "@/settings/contracts";
import type { WorkbenchProject, WorkbenchThread } from "@/workbench/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

function settings(isAdmin: boolean): SettingsSnapshot { return { schemaVersion: 1, account: { userId: "user", displayName: "Arnau", email: "arnau@example.com", provider: "local", expiresAt: "2026-08-29T00:00:00.000Z" }, company: { installationId: "example", name: "Example", isAdmin }, apps: [], connectors: [{ id: "gmail", label: "Gmail", status: "requires_login", statusCode: "GMAIL_LOGIN_REQUIRED", statusDetail: "Conecta tu cuenta personal.", accountEmail: null, scopes: ["https://www.googleapis.com/auth/gmail.readonly"], connectUrl: "/api/connectors/gmail/oauth/start", disconnectUrl: null, connectionVersion: null }, { id: "outlook", label: "Outlook", status: "requires_login", statusCode: "OUTLOOK_LOGIN_REQUIRED", statusDetail: "Conecta tu cuenta personal.", accountEmail: null, scopes: ["User.Read", "Mail.Read"], connectUrl: "/api/connectors/outlook/oauth/start", disconnectUrl: null, connectionVersion: null }], memory: { enabled: true, confirmationRequired: false, scopes: ["private", "project", "company"], provenanceVisible: true, employeeRuntimeIsolated: true, sharedComputerHistory: false }, notifications: { backgroundTurns: true, approvals: true, failures: true, sound: false }, permissions: [], privacy: { conversationStorage: "company_private", providerTraining: "not_managed_here", employeeIsolation: true, memoryScope: "automatic_private_memory" }, browser: { profileScope: "private_per_employee", networkPolicy: "public_http_https_only", privateNetworkAllowed: false, mutationsRequireApproval: true, downloadsArePrivate: true } }; }
function usage(scope: "personal" | "company") { return { schemaVersion: 1, scope, generatedAt: "2026-08-29T00:00:00.000Z", userId: "user", installationId: "example", notices: [], sharedSubscription: null, internal: { turns: 2, completedTurns: 1, errorTurns: 1, stoppedTurns: 0, activeDays: 1, totalDurationMs: 95_000, averageDurationMs: 47_500, p95DurationMs: 90_000, averageFirstTextMs: null, p95FirstTextMs: null, turnsWithTokenData: 0, tokens: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 } }, ...(scope === "company" ? { members: [] } : {}) }; }
const archivedProject: WorkbenchProject = { id: "project-archived", name: "Fiscal 2025", slug: "fiscal-2025", status: "archived", pinned: false, instructions: "", sources: [], memory: { enabled: true, notes: "", updatedAt: null }, sharing: { visibility: "private", members: [] }, workspace: { id: "workspace-archived", label: "Fiscal 2025", hostType: "managed", status: "ready", isPrimary: true }, createdAt: "2026-08-28T00:00:00.000Z", updatedAt: "2026-08-28T00:00:00.000Z" };
const archivedThread: WorkbenchThread = { id: "thread-archived", projectId: "project-active", title: "Cierre de julio", status: "archived", pinned: false, createdAt: "2026-08-28T00:00:00.000Z", updatedAt: "2026-08-28T00:00:00.000Z", messages: [] };

function CustomizationFocusHarness() {
  const [open, setOpen] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={openerRef} type="button" onClick={() => setOpen(true)}>Abrir configuración</button>
    <ThemeProvider>
      <CustomizationPanel productName="Arnall AI" open={open} runtimeStatus={initialRuntimeStatus} returnFocusRef={openerRef} onClose={() => setOpen(false)} />
    </ThemeProvider>
  </>;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });
beforeEach(() => { Element.prototype.scrollTo = vi.fn(); Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) }); });

describe("CustomizationPanel", () => {
  it("keeps all sections mounted, scrolls from the index and tracks the visible section", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(settings(false))));
    render(<ThemeProvider><CustomizationPanel productName="Example AI" open runtimeStatus={initialRuntimeStatus} onClose={vi.fn()} /></ThemeProvider>);
    await screen.findByRole("link", { name: "Conectar Gmail" });
    for (const name of ["Apariencia", "Conectores", "Memoria", "Avisos", "Archivados"]) expect(screen.getAllByRole("region", { name })[0]).toBeInTheDocument();
    const connectors = screen.getByRole("region", { name: "Conectores" });
    const container = connectors.parentElement!;
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({ top: 100 } as DOMRect);
    vi.spyOn(connectors, "getBoundingClientRect").mockReturnValue({ top: 400 } as DOMRect);
    fireEvent.click(screen.getByRole("button", { name: "Conectores" }));
    expect(container.scrollTo).toHaveBeenCalledWith({ top: 276, behavior: "smooth" });
    expect(screen.getByRole("button", { name: "Conectores" })).toHaveAttribute("aria-current", "location");
    Object.defineProperty(container, "clientHeight", { configurable: true, value: 500 });
    for (const name of ["Memoria", "Avisos", "Archivados"]) vi.spyOn(screen.getAllByRole("region", { name })[0], "getBoundingClientRect").mockReturnValue({ top: 800 } as DOMRect);
    vi.mocked(connectors.getBoundingClientRect).mockReturnValue({ top: 120 } as DOMRect);
    fireEvent.scroll(container);
    expect(screen.getByRole("button", { name: "Conectores" })).toHaveAttribute("aria-current", "location");
    vi.mocked(screen.getAllByRole("region", { name: "Memoria" })[0].getBoundingClientRect).mockReturnValue({ top: 130 } as DOMRect);
    fireEvent.scroll(container);
    expect(screen.getByRole("button", { name: "Memoria" })).toHaveAttribute("aria-current", "location");
  });

  it("lists connected apps before available apps with a separator", async () => {
    const snapshot = settings(false);
    snapshot.connectors[1] = { ...snapshot.connectors[1], status: "connected" };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(snapshot)));
    render(<ThemeProvider><CustomizationPanel productName="Example AI" open initialTab="connectors" runtimeStatus={initialRuntimeStatus} onClose={vi.fn()} /></ThemeProvider>);
    const connected = await screen.findByText("Outlook");
    const available = screen.getByText("Gmail");
    expect(connected.compareDocumentPosition(available) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const separator = screen.getByRole("separator");
    expect(connected.compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(separator.compareDocumentPosition(available) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });


  it("renders the enabled mailbox as a password form for the current employee", async () => {
    const snapshot = settings(false);
    snapshot.connectors = [{ ...snapshot.connectors[0], id: "mail", label: "Correo Nominalia", connectionMethod: "password", connectUrl: "/api/connectors/mail/connect" }];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(snapshot)));
    render(<ThemeProvider><CustomizationPanel productName="G03 AI" open initialTab="connectors" runtimeStatus={initialRuntimeStatus} onClose={vi.fn()} /></ThemeProvider>);
    expect(await screen.findByLabelText("Contraseña de tu correo")).toBeInTheDocument();
    expect(screen.getByText("arnau@example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Conectar Correo Nominalia" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Conectar Correo Nominalia" })).not.toBeInTheDocument();
  });
  it("renders English connector descriptions and owner-authorization guidance", async () => {
    const snapshot = settings(false);
    snapshot.connectors = [{ ...snapshot.connectors[0], id: "shopify-themes", label: "Shopify Website · MODTIME", statusDetail: "La conexión de MODTIME necesita autorización del propietario." }];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(snapshot)));
    const view = render(<UiLocaleProvider locale="en"><ThemeProvider><CustomizationPanel productName="MODTIME AI" open initialTab="connectors" runtimeStatus={initialRuntimeStatus} onClose={vi.fn()} /></ThemeProvider></UiLocaleProvider>);
    expect(await screen.findByText("The MODTIME connection requires the store owner’s authorization.")).toBeInTheDocument();
    expect(screen.getByText("Edit your website draft: content, video, images, layout and configurator options.")).toBeInTheDocument();
    expect(screen.getByText("Shopify Website · MODTIME")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connect Shopify Website · MODTIME" })).toBeInTheDocument();
    view.rerender(<UiLocaleProvider locale="es"><ThemeProvider><CustomizationPanel productName="MODTIME AI" open initialTab="connectors" runtimeStatus={initialRuntimeStatus} onClose={vi.fn()} /></ThemeProvider></UiLocaleProvider>);
    expect(screen.getByText("La conexión de MODTIME necesita autorización del propietario.")).toBeInTheDocument();
  });
  it("opens the requested tab after hydration and on each new opening", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(settings(false))));
    const props = { productName: "MODTIME AI", runtimeStatus: initialRuntimeStatus, onClose: vi.fn() };
    const { rerender } = render(<ThemeProvider><CustomizationPanel {...props} open={false} /></ThemeProvider>);
    rerender(<ThemeProvider><CustomizationPanel {...props} open initialTab="connectors" /></ThemeProvider>);
    expect(await screen.findByRole("searchbox", { name: "Buscar apps" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apariencia" }));
    expect(screen.getByRole("searchbox")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apariencia" })).toHaveAttribute("aria-current", "location");
    rerender(<ThemeProvider><CustomizationPanel {...props} open={false} initialTab="connectors" /></ThemeProvider>);
    rerender(<ThemeProvider><CustomizationPanel {...props} open initialTab="connectors" /></ThemeProvider>);
    expect(await screen.findByRole("searchbox", { name: "Buscar apps" })).toBeInTheDocument();
  });
  it("explains the Website connection inside the MODTIME AI and separates Shopify Orders", async () => {
    const snapshot = settings(true);
    snapshot.connectors = [{ ...snapshot.connectors[0], id: "shopify-themes", label: "Shopify Website · MODTIME", connectUrl: "/api/connectors/shopify/themes/oauth/start", statusDetail: "Owner installation required." }];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(snapshot)));
    render(<ThemeProvider><CustomizationPanel productName="MODTIME AI" open initialTab="connectors" runtimeStatus={initialRuntimeStatus} onClose={vi.fn()} /></ThemeProvider>);
    expect(await screen.findByText(/no en la configuración de Shopify ni en Sidekick/)).toBeInTheDocument();
    expect(screen.getByText(/propietario de MODTIME/)).toBeInTheDocument();
    expect(screen.getByText("Owner installation required.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Conectar Shopify Website · MODTIME" })).toHaveAttribute("href", "/api/connectors/shopify/themes/oauth/start");
  });

  it.each([false, true])("hides usage from employees and administrators (administrator=%s)", async (isAdmin) => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => Response.json(settings(isAdmin)));
    vi.stubGlobal("fetch", fetchMock);
    render(<ThemeProvider><CustomizationPanel productName="Arnall AI" open runtimeStatus={initialRuntimeStatus} onClose={vi.fn()} /></ThemeProvider>);
    expect(await screen.findByRole("button", { name: "Apariencia" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Uso" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Saldo semanal|Suscripción compartida|Minutos trabajados|Uso por empleado/)).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/settings")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/settings", { cache: "no-store" });
  });

  it.each(["verified", "failed"])("shows callback %s and new-chat guidance without treating URL as connection proof", async (status) => {
    window.history.replaceState(null, "", `/?settings=connectors&connection=${status}`);
    const snapshot = settings(false);
    snapshot.connectors = [{ ...snapshot.connectors[0], id: "composio-gmail" }];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => Response.json(String(input) === "/api/settings" ? snapshot : usage("personal"))));
    render(<ThemeProvider><CustomizationPanel productName="Arnall AI" open initialTab="connectors" runtimeStatus={initialRuntimeStatus} onClose={vi.fn()} /></ThemeProvider>);
    expect(await screen.findByText(/Conecta tus apps y úsalas directamente en el chat/)).toBeInTheDocument();
    expect(screen.getByText(status === "failed" ? /No se completó la conexión/ : /estado verificado de tus conexiones/)).toBeInTheDocument();
    expect(screen.queryByText("Conectado")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Conectar Gmail" })).toBeInTheDocument();
  });
  it.each(["shopify", "shopify_themes"])("shows a Shopify callback failure without claiming a connection: %s", async (connector) => {
    window.history.replaceState(null, "", `/?settings=connectors&${connector}=failed&reason=MODTIME_SHOPIFY_TOKEN_EXCHANGE_FAILED`);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(settings(false))));
    render(<ThemeProvider><CustomizationPanel productName="MODTIME AI" open initialTab="connectors" runtimeStatus={initialRuntimeStatus} onClose={vi.fn()} /></ThemeProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent("No se completó la conexión");
    expect(screen.queryByText("Conectado")).not.toBeInTheDocument();
  });

  it("returns focus to the stable opener while its exit is inert", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/settings"
      ? new Response(JSON.stringify(settings(false)), { status: 200 })
      : new Response(JSON.stringify(usage("personal")), { status: 200 })));
    render(<CustomizationFocusHarness />);
    const opener = screen.getByRole("button", { name: "Abrir configuración" });
    opener.focus();
    fireEvent.click(opener);
    await screen.findByRole("dialog", { name: "Configuración de Arnall AI" });

    fireEvent.keyDown(document, { key: "Escape" });
    const exiting = document.querySelector('[data-overlay-presence="exiting"]');
    expect(exiting).toHaveAttribute("inert");
    expect(exiting).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("dialog", { name: "Configuración de Arnall AI" })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("keeps employee settings to theme, notifications and personal usage", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/settings") return new Response(JSON.stringify(settings(false)), { status: 200 });
      if (url === "/api/usage/me") return new Response(JSON.stringify(usage("personal")), { status: 200 });
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ThemeProvider><CustomizationPanel productName="Arnall AI" open runtimeStatus={initialRuntimeStatus} onClose={vi.fn()} /></ThemeProvider>);
    expect(await screen.findByRole("button", { name: "Apariencia" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Avisos" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Conectores" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Memoria" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archivados" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Uso" })).not.toBeInTheDocument();
    for (const hidden of ["Herramientas", "Permisos", "Datos y privacidad", "Navegador y red", "Equipo", "Alta local", "Grupos y políticas", "Registro de auditoría"]) expect(screen.queryByText(hidden)).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/usage/company", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Conectores" }));
    expect(screen.getByRole("link", { name: "Conectar Gmail" })).toHaveAttribute("href", "/api/connectors/gmail/oauth/start");
    expect(screen.getByRole("link", { name: "Conectar Outlook" })).toHaveAttribute("href", "/api/connectors/outlook/oauth/start");
  });

  it("distinguishes administrator OAuth setup from a personal connection", async () => {
    const snapshot = settings(false);
    snapshot.connectors = [{
      id: "outlook",
      label: "Outlook",
      status: "admin_setup_required",
      statusCode: "OUTLOOK_ENTRA_TENANT_NOT_CONFIGURED",
      statusDetail: "Disponible para conectar cuando el administrador complete Microsoft Entra OAuth.",
      accountEmail: null,
      scopes: ["User.Read", "Mail.Read"],
      connectUrl: null,
      disconnectUrl: null,
      connectionVersion: null,
    }];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/settings"
      ? new Response(JSON.stringify(snapshot), { status: 200 })
      : new Response(JSON.stringify(usage("personal")), { status: 200 })));

    render(<ThemeProvider><CustomizationPanel productName="Arnall AI" open runtimeStatus={initialRuntimeStatus} onClose={vi.fn()} /></ThemeProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Conectores" }));

    expect(screen.getByText("Falta configuración")).toBeInTheDocument();
    expect(screen.getByText(/administrador complete Microsoft Entra OAuth/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Conectar Outlook" })).not.toBeInTheDocument();
    expect(screen.queryByText("No tienes conectores autorizados.")).not.toBeInTheDocument();
  });

  it("shows reviewed service coverage and reconnect/disconnect controls for a connected personal toolkit", async () => {
    const snapshot = settings(false);
    snapshot.connectors = [{
      ...snapshot.connectors[0],
      id: "composio-googlecalendar",
      label: "Google Calendar",
      status: "connected",
      accountEmail: "arnau@example.com",
      connectUrl: "/api/connectors/composio/googlecalendar/connect",
      disconnectUrl: "/api/connectors/composio/googlecalendar/disconnect",
      connectionVersion: 2,
    }];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/settings"
      ? new Response(JSON.stringify(snapshot), { status: 200 })
      : new Response(JSON.stringify(usage("personal")), { status: 200 })));

    render(<ThemeProvider><CustomizationPanel productName="Arnall AI" open initialTab="connectors" runtimeStatus={initialRuntimeStatus} onClose={vi.fn()} /></ThemeProvider>);

    expect(await screen.findByText(/Consulta tus calendarios y eventos/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Reconectar Google Calendar" })).toHaveAttribute("href", "/api/connectors/composio/googlecalendar/connect");
    expect(screen.getByRole("button", { name: "Desconectar Google Calendar" })).toBeInTheDocument();
  });

  it("keeps archived projects and conversations in settings and restores them explicitly", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/settings") return new Response(JSON.stringify(settings(false)), { status: 200 });
      if (url === "/api/usage/me") return new Response(JSON.stringify(usage("personal")), { status: 200 });
      return new Response("{}", { status: 404 });
    });
    const onRestoreProject = vi.fn();
    const onRestoreThread = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<ThemeProvider><CustomizationPanel productName="Arnall AI" open runtimeStatus={initialRuntimeStatus} projects={[archivedProject]} threads={[archivedThread]} onRestoreProject={onRestoreProject} onRestoreThread={onRestoreThread} onClose={vi.fn()} /></ThemeProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "Archivados" }));
    expect(screen.getByText("Fiscal 2025")).toBeInTheDocument();
    expect(screen.getByText("Cierre de julio")).toBeInTheDocument();
    const restoreButtons = screen.getAllByRole("button", { name: "Restaurar" });
    fireEvent.click(restoreButtons[0]);
    fireEvent.click(restoreButtons[1]);
    expect(onRestoreProject).toHaveBeenCalledWith(archivedProject);
    expect(onRestoreThread).toHaveBeenCalledWith(archivedThread);
  });

  it("shows the memory list and controls directly inside settings", async () => {
    const projectId = "00000000-0000-4000-8000-000000000011";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/settings") return new Response(JSON.stringify(settings(false)), { status: 200 });
      if (url === "/api/usage/me") return new Response(JSON.stringify(usage("personal")), { status: 200 });
      if (url === "/api/memory?status=all&limit=100") return new Response(JSON.stringify({ memories: [] }), { status: 200 });
      if (url === `/api/memory/proposals?projectId=${projectId}`) return new Response(JSON.stringify({ proposals: [], memories: [{ schemaVersion: 1, memoryId: "00000000-0000-4000-8000-000000000099", proposalId: "00000000-0000-4000-8000-000000000098", installationId: "example", ownerUserId: "user", projectId: null, scope: "private", kind: "recollection", content: "Prefiero informes en PDF.", provenance: { sourceType: "background-conversation", threadId: "thread-1", turnId: "turn-1", callId: "automatic:recollection-informes:turn-1", toolNames: [], sourceExcerpt: "Prefiero informes en PDF.", capturedAt: "2026-08-30T10:00:00.000Z" }, status: "active", revision: 1, createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", deletedAt: null, deletedBy: null }], allowCompanyScope: false }), { status: 200 });
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ThemeProvider><CustomizationPanel productName="Arnall AI" open activeProjectId={projectId} runtimeStatus={initialRuntimeStatus} onClose={vi.fn()} /></ThemeProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Memoria" }));
    expect(screen.getAllByText(/Arnall AI/).length).toBeGreaterThan(0);
    expect(await screen.findByText("Prefiero informes en PDF.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Editar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Eliminar" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Gestionar memoria" })).not.toBeInTheDocument();
  });

  it("keeps administrator and policy shortcuts out of employee settings", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/settings") return new Response(JSON.stringify(settings(true)), { status: 200 });
      if (url === "/api/usage/me") return new Response(JSON.stringify(usage("personal")), { status: 200 });
      if (url === "/api/usage/company") return new Response(JSON.stringify(usage("company")), { status: 200 });
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ThemeProvider><CustomizationPanel productName="Arnall AI" open runtimeStatus={initialRuntimeStatus} onClose={vi.fn()} /></ThemeProvider>);
    await waitFor(() => expect(screen.getByText("Claro u oscuro")).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: "Administración" })).not.toBeInTheDocument();
    expect(screen.queryByText(/políticas de empresa/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Equipo" })).not.toBeInTheDocument();
    expect(screen.queryByText("Alta local")).not.toBeInTheDocument();
  });

  it("retries loading settings after a recoverable error", async () => {
    let settingsRequests = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/settings") {
        settingsRequests += 1;
        return settingsRequests === 1
          ? new Response("{}", { status: 503 })
          : new Response(JSON.stringify(settings(false)), { status: 200 });
      }
      if (url === "/api/usage/me") return new Response(JSON.stringify(usage("personal")), { status: 200 });
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ThemeProvider><CustomizationPanel productName="Arnall AI" open runtimeStatus={initialRuntimeStatus} onClose={vi.fn()} /></ThemeProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Reintentar" }));

    await waitFor(() => expect(settingsRequests).toBe(2));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Reintentar" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Avisos" })).toBeInTheDocument();
  });
});
