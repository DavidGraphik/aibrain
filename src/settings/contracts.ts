import type { PersonalConnectorSettings } from "@/settings/connector-settings";

export const CONTROLLABLE_APP_IDS = [
  "web-search",
  "image-generation",
  "skills",
  // Retained only to read existing strict settings records; no active capability.
  "managed-browser",
] as const;

export type ControllableAppId = typeof CONTROLLABLE_APP_IDS[number];
export type AppKind = "runtime" | "capability" | "plugin" | "connector";
export type AppStatus = "connected" | "available" | "blocked" | "not_configured";

export type AppCatalogueItem = {
  id: string;
  label: string;
  description: string;
  kind: AppKind;
  status: AppStatus;
  statusDetail: string;
  scopes: string[];
  permissionActions: Array<"consult" | "respond" | "execute" | "publish">;
  approvalRequired: boolean;
  installationEnabled: boolean;
  userEnabled: boolean;
  effectiveEnabled: boolean;
  canUserChange: boolean;
  canAdminChange: boolean;
  configurationHint: string | null;
};

export type NotificationSettings = {
  backgroundTurns: boolean;
  approvals: boolean;
  failures: boolean;
  sound: boolean;
};

export type PermissionSummary = {
  action: "consult" | "respond" | "execute" | "publish";
  effect: "allow" | "deny" | "not_defined";
  rules: Array<{ ruleId: string; effect: "allow" | "deny"; instruction: string }>;
};

export type SettingsSnapshot = {
  schemaVersion: 1;
  account: {
    userId: string;
    displayName: string;
    email: string;
    provider: "demo" | "local";
    expiresAt: string;
  };
  company: {
    installationId: string;
    name: string;
    isAdmin: boolean;
  };
  apps: AppCatalogueItem[];
  connectors: PersonalConnectorSettings[];
  memory: {
    enabled: true;
    confirmationRequired: false;
    scopes: Array<"private" | "project" | "company">;
    provenanceVisible: true;
    employeeRuntimeIsolated: true;
    sharedComputerHistory: false;
  };
  notifications: NotificationSettings;
  permissions: PermissionSummary[];
  privacy: {
    conversationStorage: "company_private";
    providerTraining: "not_managed_here";
    employeeIsolation: true;
    memoryScope: "automatic_private_memory";
  };
  browser: {
    profileScope: "private_per_employee";
    networkPolicy: "public_http_https_only";
    privateNetworkAllowed: false;
    mutationsRequireApproval: true;
    downloadsArePrivate: true;
  };
};

export type SettingsPatch =
  | { target: "installation-app"; appId: ControllableAppId; enabled: boolean }
  | { target: "notifications"; values: Partial<NotificationSettings> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isControllableAppId(value: unknown): value is ControllableAppId {
  return typeof value === "string" && CONTROLLABLE_APP_IDS.includes(value as ControllableAppId);
}

export function isSettingsPatch(value: unknown): value is SettingsPatch {
  if (!isRecord(value) || typeof value.target !== "string") return false;
  if (value.target === "installation-app") {
    return Object.keys(value).length === 3 &&
      isControllableAppId(value.appId) && value.appId !== "managed-browser" && typeof value.enabled === "boolean";
  }
  if (value.target !== "notifications" || !isRecord(value.values) ||
      Object.keys(value).length !== 2) return false;
  const values = value.values;
  const keys = Object.keys(values);
  return keys.length > 0 && keys.every((key) =>
    ["backgroundTurns", "approvals", "failures", "sound"].includes(key) &&
    typeof values[key] === "boolean");
}

export function isSettingsSnapshot(value: unknown): value is SettingsSnapshot {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.account) ||
      !isRecord(value.company) || !Array.isArray(value.apps) || !Array.isArray(value.connectors) ||
      !isRecord(value.memory) ||
      !isRecord(value.notifications) || !Array.isArray(value.permissions) ||
      !isRecord(value.privacy) || !isRecord(value.browser)) return false;
  const notifications = value.notifications;
  return typeof value.account.userId === "string" &&
    typeof value.account.displayName === "string" &&
    typeof value.account.email === "string" &&
    typeof value.company.installationId === "string" &&
    typeof value.company.name === "string" &&
    typeof value.company.isAdmin === "boolean" &&
    value.apps.every((item) => isRecord(item) && typeof item.id === "string" &&
      typeof item.label === "string" && typeof item.effectiveEnabled === "boolean") &&
    value.connectors.every((item) => isRecord(item) && typeof item.id === "string" && typeof item.label === "string" &&
      ["connected", "requires_login", "admin_setup_required", "unavailable"].includes(String(item.status)) &&
      (item.connectionMethod === undefined || item.connectionMethod === "password") &&
      (item.connectUrl === null || typeof item.connectUrl === "string") && (item.disconnectUrl === null || typeof item.disconnectUrl === "string")) &&
    value.memory.enabled === true && value.memory.confirmationRequired === false && value.memory.provenanceVisible === true &&
    value.memory.employeeRuntimeIsolated === true && value.memory.sharedComputerHistory === false && Array.isArray(value.memory.scopes) &&
    ["backgroundTurns", "approvals", "failures", "sound"].every((key) =>
      typeof notifications[key] === "boolean");
}
