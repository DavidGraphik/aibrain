import { instantlyCapabilityForSession } from "@/connectors/instantly-service";
import { composioCapabilitiesForSession } from "@/connectors/composio-service";
import { modtimeReportingCapabilities, MODTIME_META_ID } from "@/connectors/modtime-reporting";
import "server-only";

import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AuthSession } from "@/auth/types";
import { isWorkspaceAdmin } from "@/admin/server-service";
import { workspacePolicyForIdentity } from "@/admin/policy-service";
import { loadInstallationConfig } from "@/config/installation";
import { codexManagedAppCapabilities } from "@/connectors/server-service";
import { MarkdownPermissionProvider } from "@/permissions";
import type { PermissionAction } from "@/permissions/types";
import { readRuntimeConfig } from "@/runtime/config";
import { FilePermissionResolutionAuditSink } from "@/runtime/permission-audit-sink";
import {
  CONTROLLABLE_APP_IDS,
  type AppCatalogueItem,
  type ControllableAppId,
  type PermissionSummary,
  type SettingsPatch,
  type SettingsSnapshot,
} from "@/settings/contracts";
import { FileSettingsStore } from "@/settings/preferences-store";
import { gmailCapabilityForSession } from "@/connectors/gmail-server-service";
import { companyMailCapabilityForSession } from "@/connectors/company-mail-server-service";
import { COMPANY_MAIL_CONNECTOR_ID, COMPANY_MAIL_SCOPES } from "@/connectors/company-mail-contracts";
import { GMAIL_CONNECTOR_ID, GMAIL_MINIMUM_SCOPES } from "@/connectors/gmail-contracts";
import { outlookCapabilityForSession } from "@/connectors/outlook-server-service";
import { mailCapabilityForSession } from "@/connectors/mail-server-service";
import { OUTLOOK_API_SCOPES, OUTLOOK_CONNECTOR_ID } from "@/connectors/outlook-contracts";
import { catalogRuntimeEnforcer } from "@/catalog/access-service";
import { projectPersonalConnectorSettings, type PersonalConnectorSettings } from "@/settings/connector-settings";

const ACTIONS: PermissionAction[] = ["consult", "respond", "execute", "publish"];

async function context(session: AuthSession) {
  const installation = await loadInstallationConfig();
  if (installation.installationId !== session.tenant.id) {
    throw new Error("Authenticated installation does not match settings storage.");
  }
  return {
    installation,
    store: new FileSettingsStore(installation.paths.dataRoot, installation.paths.usersRoot),
    isAdmin: await isWorkspaceAdmin(session),
  };
}

async function permissionsForSession(session: AuthSession): Promise<PermissionSummary[]> {
  const installation = await loadInstallationConfig();
  try {
    const workspacePolicy = await workspacePolicyForIdentity(installation.installationId, session.user.id);
    const provider = new MarkdownPermissionProvider({
      installations: [{
        installationId: installation.installationId,
        roots: {
          installationPolicyRoot: installation.paths.companyContextRoot,
          rolesRoot: path.join(installation.paths.dataRoot, "permission-scopes", "roles"),
          projectsRoot: path.join(installation.paths.dataRoot, "permission-scopes", "projects"),
          usersRoot: installation.paths.usersRoot,
        },
      }],
      auditSink: new FilePermissionResolutionAuditSink({
        installationId: installation.installationId,
        userId: session.user.id,
        usersRoot: installation.paths.usersRoot,
      }),
    });
    const resolved = await provider.resolveForUser(
      installation.installationId,
      session.user.id,
      { turnId: randomUUID(), roleId: workspacePolicy.roleId, projectId: null },
    );
    return ACTIONS.map((action) => {
      const rules = resolved.rules.filter((rule) => rule.action === action).map((rule) => ({
        ruleId: rule.ruleId,
        effect: rule.effect,
        instruction: rule.instruction,
      }));
      if (!workspacePolicy.policy.capabilities[action]) {
        rules.push({
          ruleId: "workspace.group-policy",
          effect: "deny",
          instruction: "Bloqueado por la política efectiva del rol o de un grupo del workspace.",
        });
      }
      return {
        action,
        effect: rules.some((rule) => rule.effect === "deny")
          ? "deny" as const
          : rules.some((rule) => rule.effect === "allow") ? "allow" as const : "not_defined" as const,
        rules,
      };
    });
  } catch {
    return ACTIONS.map((action) => ({ action, effect: "not_defined", rules: [] }));
  }
}

function controlledApp(
  id: ControllableAppId,
  definition: Omit<AppCatalogueItem,
    "id" | "status" | "statusDetail" | "installationEnabled" | "userEnabled" |
    "effectiveEnabled" | "canUserChange" | "canAdminChange">,
  installationEnabled: boolean,
  userEnabled: boolean,
  configured: boolean,
  isAdmin: boolean,
): AppCatalogueItem {
  const effectiveEnabled = configured && installationEnabled && userEnabled;
  return {
    id,
    ...definition,
    status: !configured ? "not_configured" : !installationEnabled ? "blocked" :
      effectiveEnabled ? "available" : "available",
    statusDetail: !configured
      ? "El runtime no ha publicado esta capacidad."
      : !installationEnabled
        ? "Bloqueada por la empresa."
        : !userEnabled ? "Desactivada para tu cuenta." : "Disponible para usar.",
    installationEnabled,
    userEnabled,
    effectiveEnabled,
    canUserChange: configured && installationEnabled,
    canAdminChange: isAdmin,
  };
}

async function appCatalogue(session: AuthSession, isAdmin: boolean) {
  const { installation, store } = await context(session);
  const [user, company, workspacePolicy] = await Promise.all([
    store.readUser(session.user.id),
    store.readInstallation(),
    workspacePolicyForIdentity(session.tenant.id, session.user.id),
  ]);
  const runtime = readRuntimeConfig(installation.installationId);
  const runtimeConfigured = runtime.mode === "codex";
  const switches = Object.fromEntries(CONTROLLABLE_APP_IDS.map((id) => [id, {
    installation: company.apps[id] && workspacePolicy.policy.apps[id],
    user: user.apps[id],
  }])) as Record<ControllableAppId, { installation: boolean; user: boolean }>;

  const controlled = <Id extends ControllableAppId>(
    id: Id,
    definition: Parameters<typeof controlledApp>[1],
    configured = runtimeConfigured,
  ) => controlledApp(
    id,
    definition,
    switches[id].installation,
    switches[id].user,
    configured,
    isAdmin,
  );

  const builtInApps = [
    {
      id: "codex-runtime",
      label: "Asistente de trabajo",
      description: "Motor privado que responde, trabaja con archivos y ejecuta tareas dentro del workspace.",
      kind: "runtime",
      status: runtimeConfigured ? "available" : "not_configured",
      statusDetail: runtimeConfigured ? "Runtime configurado en el servidor." : "CHAT_RUNTIME=codex no está configurado.",
      scopes: ["Workspace aislado del empleado", "Conversaciones de la empresa"],
      permissionActions: ["consult", "respond", "execute"],
      approvalRequired: true,
      installationEnabled: runtimeConfigured,
      userEnabled: runtimeConfigured,
      effectiveEnabled: runtimeConfigured,
      canUserChange: false,
      canAdminChange: false,
      configurationHint: runtimeConfigured ? null : "Configura el runtime Codex en el servidor.",
    },
    controlled("web-search", {
      label: "Búsqueda web",
      description: "Consulta información pública y devuelve fuentes durante una conversación.",
      kind: "capability",
      scopes: ["Internet público HTTP/HTTPS", "Sin acceso a red privada"],
      permissionActions: ["consult"],
      approvalRequired: false,
      configurationHint: runtimeConfigured ? null : "Conecta un runtime que publique búsqueda web.",
    }),
    controlled("image-generation", {
      label: "Generación de imágenes",
      description: "Crea imágenes cuando el runtime conectado publica esa capacidad.",
      kind: "capability",
      scopes: ["Prompt del turno", "Artefactos privados del proyecto"],
      permissionActions: ["respond", "execute"],
      approvalRequired: false,
      configurationHint: runtimeConfigured ? null : "Conecta un runtime compatible con imágenes.",
    }),
    controlled("skills", {
      label: "Skills instaladas",
      description: "Procedimientos revisados por la empresa que amplían la forma de trabajar del asistente.",
      kind: "plugin",
      scopes: ["Solo skills publicadas por este servidor"],
      permissionActions: ["consult", "respond", "execute"],
      approvalRequired: true,
      configurationHint: runtimeConfigured ? null : "Instala las skills en el runtime del empleado.",
    }),
    {
      id: "documents",
      label: "Archivos y documentos",
      description: "Adjunta, previsualiza y publica documentos mediante el flujo de confirmación seguro.",
      kind: "capability",
      status: "connected",
      statusDetail: "Incluida y controlada por PERMISSIONS.md.",
      scopes: ["Orígenes de lectura permitidos", "Destino de publicación de la empresa"],
      permissionActions: ["consult", "publish"],
      approvalRequired: true,
      installationEnabled: true,
      userEnabled: true,
      effectiveEnabled: true,
      canUserChange: false,
      canAdminChange: false,
      configurationHint: null,
    },
  ] satisfies AppCatalogueItem[];

  // A connector has no settings placeholder: it appears only after a personal
  // binding is present and the server-only provider has verified it callable.
  // The read-only API retains explicit failure codes for an operator without
  // advertising a non-working application in the employee UI.
  const connectedApps = await codexManagedAppCapabilities(session)
    .then((capabilities) => capabilities.filter((capability) => capability.status === "connected"))
    .catch(() => []);
  return [
    ...builtInApps,
    ...connectedApps.map((capability) => ({
      id: capability.connectorId,
      label: capability.label,
      description: "Disponibilidad de una aplicación MCP ya autenticada por Codex.",
      kind: "connector" as const,
      status: "connected" as const,
      statusDetail: "Conectada y disponible para la operación de lectura publicada.",
      scopes: ["Disponibilidad de la aplicación instalada"],
      permissionActions: ["consult" as const],
      approvalRequired: false,
      installationEnabled: true,
      userEnabled: true,
      effectiveEnabled: true,
      canUserChange: false,
      canAdminChange: false,
      configurationHint: null,
    })),
  ] satisfies AppCatalogueItem[];
}

export async function featurePolicyForUser(session: AuthSession) {
  if (session.provider === "demo") {
    return Object.fromEntries(CONTROLLABLE_APP_IDS.map((id) => [id, true])) as Record<ControllableAppId, boolean>;
  }
  const { store } = await context(session);
  const [user, installation, workspacePolicy] = await Promise.all([
    store.readUser(session.user.id),
    store.readInstallation(),
    workspacePolicyForIdentity(session.tenant.id, session.user.id),
  ]);
  return Object.fromEntries(CONTROLLABLE_APP_IDS.map((id) => [
    id,
    user.apps[id] && installation.apps[id] && workspacePolicy.policy.apps[id],
  ])) as Record<ControllableAppId, boolean>;
}

export async function featurePolicyForIdentity(installationId: string, userId: string) {
  const installation = await loadInstallationConfig();
  if (installation.installationId !== installationId) {
    throw new Error("Authenticated installation does not match feature policy storage.");
  }
  const store = new FileSettingsStore(installation.paths.dataRoot, installation.paths.usersRoot);
  const [user, company, workspacePolicy] = await Promise.all([
    store.readUser(userId),
    store.readInstallation(),
    workspacePolicyForIdentity(installationId, userId),
  ]);
  return Object.fromEntries(CONTROLLABLE_APP_IDS.map((id) => [
    id,
    user.apps[id] && company.apps[id] && workspacePolicy.policy.apps[id],
  ])) as Record<ControllableAppId, boolean>;
}

export async function settingsSnapshot(session: AuthSession): Promise<SettingsSnapshot> {
  const { installation, store, isAdmin } = await context(session);
  const catalog = await catalogRuntimeEnforcer(installation.installationId, session.user.id);
  const mailAuthorized = catalog.allowsConnector(COMPANY_MAIL_CONNECTOR_ID);
  const gmailAuthorized = catalog.allowsConnector(GMAIL_CONNECTOR_ID);
  const outlookAuthorized = catalog.allowsConnector(OUTLOOK_CONNECTOR_ID);
  const [userSettings, permissions, apps, gmail, outlook, companyMail, mail] = await Promise.all([
    store.readUser(session.user.id),
    permissionsForSession(session),
    appCatalogue(session, isAdmin),
    gmailAuthorized ? gmailCapabilityForSession(session).catch(() => null) : Promise.resolve(null),
    outlookAuthorized ? outlookCapabilityForSession(session).catch(() => null) : Promise.resolve(null),
    mailAuthorized ? companyMailCapabilityForSession(session).catch(() => null) : Promise.resolve(null),
    mailCapabilityForSession(session),
  ]);
  const connectors: PersonalConnectorSettings[] = [];
  if (mail) {
    connectors.push({
      ...projectPersonalConnectorSettings(mail, ["mail.read", "mail.draft", "mail.send", "mail.organize"], {
        connected: "Tu buzón está conectado. Puedes usarlo directamente en el chat.",
        requiresLogin: "Conecta tu buzón con la contraseña de tu correo.",
        adminSetupRequired: "La conexión de correo todavía no está preparada.",
        unavailable: "No se ha podido comprobar el buzón. Puedes volver a conectarlo.",
      }),
      connectionMethod: "password",
    });
  }
  if (catalog.allowsConnector("instantly") && installation.connectors?.instantly?.enabled) {
    connectors.push(projectPersonalConnectorSettings(await instantlyCapabilityForSession(installation, session), ["instantly:read"], {
      connected: "Workspace de empresa verificado por ID. Solo lectura; las respuestas comerciales son borradores para revisión.",
      requiresLogin: "El administrador debe reconectar la credencial del workspace.",
      adminSetupRequired: "El administrador debe configurar la conexión de Instantly.",
      unavailable: "No se puede verificar el workspace de Instantly ahora mismo.",
    }));
  }
  for (const capability of await modtimeReportingCapabilities(installation.installationId, session.user.id)) {
    connectors.push(projectPersonalConnectorSettings(capability,
      capability.connectorId === MODTIME_META_ID ? ["ads_read"] : ["read_orders", "read_draft_orders"], {
        connected: capability.connectorId === MODTIME_META_ID ? "Cuenta de anuncios de MODTIME verificada mediante consulta en directo. Solo lectura." : "Tienda y permisos de Shopify verificados en directo. Pedidos en modo de solo lectura; el historial limitado no demuestra clientes nuevos ni CAC.",
        requiresLogin: "La conexión de MODTIME necesita autorización del propietario.",
        adminSetupRequired: "Pendiente de instalación autorizada y de una conexión OAuth compatible con la tienda MODTIME.",
        unavailable: "No se ha podido verificar la conexión en directo. Los informes guardados no sustituyen esta comprobación.",
      }));
  }
  if (mailAuthorized) connectors.push(projectPersonalConnectorSettings(companyMail ?? {
    connectorId: COMPANY_MAIL_CONNECTOR_ID, label: "Correo de empresa", status: "degraded", statusCode: "MAIL_CAPABILITY_CHECK_FAILED", checkedAt: null,
    effectiveOperations: [], approvalRequiredOperations: [], connectUrl: null, disconnectUrl: null, accountEmail: null, connectionVersion: null,
  }, COMPANY_MAIL_SCOPES, {
    connected: "Acceso personal guardado. La conexión al buzón se comprueba en cada lectura.",
    requiresLogin: "Conecta tu buzón de empresa con acceso de lectura.",
    adminSetupRequired: "El administrador debe preparar el servidor de correo y el cifrado.",
    unavailable: "No se puede comprobar la conexión de correo.",
  }));
  if (gmailAuthorized) {
    connectors.push(projectPersonalConnectorSettings(
      gmail ?? {
        connectorId: GMAIL_CONNECTOR_ID,
        label: "Google",
        status: "degraded",
        statusCode: "GMAIL_CAPABILITY_CHECK_FAILED",
        checkedAt: null,
        effectiveOperations: [],
        approvalRequiredOperations: [],
        connectUrl: null,
        disconnectUrl: null,
        accountEmail: null,
        connectionVersion: null,
      },
      GMAIL_MINIMUM_SCOPES,
      {
        connected: "Cuenta personal verificada mediante lectura de perfil.",
        requiresLogin: "Disponible para conectar con tu cuenta personal de Gmail.",
        adminSetupRequired: "Disponible para conectar cuando el administrador complete Google Cloud OAuth.",
        unavailable: "Gmail está autorizado, pero no se puede comprobar ahora mismo.",
      },
    ));
  }
  const g03ManagedOutlook = installation.installationId === "g03-production" &&
    installation.connectors?.composio?.toolkits.some(toolkit => toolkit.slug === "outlook");
  if (outlookAuthorized && (!g03ManagedOutlook || outlook?.status === "connected")) {
    connectors.push(projectPersonalConnectorSettings(
      outlook ?? {
        connectorId: OUTLOOK_CONNECTOR_ID,
        label: "Microsoft 365",
        status: "degraded",
        statusCode: "OUTLOOK_CAPABILITY_CHECK_FAILED",
        checkedAt: null,
        effectiveOperations: [],
        approvalRequiredOperations: [],
        connectUrl: null,
        disconnectUrl: null,
        accountEmail: null,
        connectionVersion: null,
      },
      OUTLOOK_API_SCOPES,
      {
        connected: "Cuenta personal verificada mediante Microsoft Graph.",
        requiresLogin: "Disponible para conectar con tu cuenta personal de Outlook.",
        adminSetupRequired: "Disponible para conectar cuando el administrador complete Microsoft Entra OAuth.",
        unavailable: "Outlook está autorizado, pero no se puede comprobar ahora mismo.",
      },
    ));
  }
  for (const capability of await composioCapabilitiesForSession(session)) {
    const toolkit = installation.connectors?.composio?.toolkits.find(t => `composio-${t.slug.replaceAll("_", "-")}` === capability.connectorId);
    connectors.push(projectPersonalConnectorSettings(capability, toolkit?.scopes ?? [], {
      connected: "Conexión personal activa, comprobada con el proveedor.",
      requiresLogin: "Conecta tu cuenta y autoriza los permisos de lectura indicados.",
      adminSetupRequired: "El administrador debe configurar el proveedor de conexiones.",
      unavailable: "No se puede verificar la conexión. Puedes reconectar o reintentar la revocación.",
    }));
  }
  return {
    schemaVersion: 1,
    account: {
      userId: session.user.id,
      displayName: session.user.name,
      email: session.user.email,
      provider: session.provider,
      expiresAt: session.expiresAt,
    },
    company: {
      installationId: installation.installationId,
      name: installation.companyName,
      isAdmin,
    },
    apps,
    connectors,
    memory: {
      enabled: true,
      confirmationRequired: false,
      scopes: ["private", "project", "company"],
      provenanceVisible: true,
      employeeRuntimeIsolated: true,
      sharedComputerHistory: false,
    },
    notifications: userSettings.notifications,
    permissions,
    privacy: {
      conversationStorage: "company_private",
      providerTraining: "not_managed_here",
      employeeIsolation: true,
      memoryScope: "automatic_private_memory",
    },
    browser: {
      profileScope: "private_per_employee",
      networkPolicy: "public_http_https_only",
      privateNetworkAllowed: false,
      mutationsRequireApproval: true,
      downloadsArePrivate: true,
    },
  };
}

export async function updateSettings(session: AuthSession, patch: SettingsPatch) {
  const { store, isAdmin } = await context(session);
  if (patch.target === "installation-app") {
    if (!isAdmin) {
      const error = new Error("Settings administrator permission is required.") as Error & { code: string };
      error.code = "SETTINGS_ADMIN_REQUIRED";
      throw error;
    }
    await store.updateInstallation((current) => ({
      ...current,
      apps: { ...current.apps, [patch.appId]: patch.enabled },
    }));
  } else {
    await store.updateUser(session.user.id, (current) => ({
      ...current,
      notifications: { ...current.notifications, ...patch.values },
    }));
  }
  return settingsSnapshot(session);
}
