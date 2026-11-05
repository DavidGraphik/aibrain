import { isComposioToolkitConfig, type ComposioToolkitConfig } from "@/connectors/composio-config";
import path from "node:path";

export const INSTALLATION_CONFIG_SCHEMA_VERSION = 1 as const;

export type InstallationBranding = {
  productName: string;
  logoPath: string;
  faviconPath: string;
  accentColor: string;
};

export type InstallationPaths = {
  dataRoot: string;
  companyContextRoot: string;
  usersRoot: string;
  sourceReadRoot: string;
  publishWriteRoot: string;
  backupsRoot: string;
};

export type CodexManagedAppActionConfig = {
  appId: string;
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
  correlationField: string;
  readback: {
    server: string;
    tool: string;
    arguments: Record<string, unknown>;
    correlationArgument: string;
  };
};

export type GmailConnectorConfig = {
  enabled: boolean;
};

export type OutlookConnectorConfig = {
  enabled: boolean;
  /** Exact Microsoft Entra tenant; `common` and `consumers` are intentionally unsupported. */
  tenantId?: string;
};

export type CompanyMailConnectorConfig = {
  enabled: boolean;
  /** Administrator-owned exact IMAPS hostname; never supplied by the employee or model. */
  host: string;
  emailDomain: string;
};

export type InstallationConnectors = {
  companyMail?: CompanyMailConnectorConfig;
  codexManagedAppAction?: CodexManagedAppActionConfig;
  composio?: { toolkits: ComposioToolkitConfig[] };
  gmail?: GmailConnectorConfig;
  mail?: { enabled: boolean; provider: "nominalia" };
  outlook?: OutlookConnectorConfig;
  instantly?: { enabled: boolean; workspaceId: string };
};

/** Immutable GraphikAI baseline; workspace admins may not modify it through the catalog API. */
export type InstallationCatalog = {
  graphikAIManagedSkills: Array<{ id: string; label: string }>;
};

export type InstallationConfig = {
  schemaVersion: typeof INSTALLATION_CONFIG_SCHEMA_VERSION;
  installationId: string;
  companyName: string;
  companySlug: string;
  publicUrl: string;
  branding: InstallationBranding;
  paths: InstallationPaths;
  connectors?: InstallationConnectors;
  catalog?: InstallationCatalog;
  /** Server-owned, installation-wide budget; cached input counts toward this total. */
  usageLimits?: { weeklyTokens: number; timeZone: "Europe/Madrid"; unlimitedUntil?: string };
};

export type InstallationConfigIssue = {
  path: string;
  message: string;
};

export class InstallationConfigValidationError extends Error {
  readonly issues: readonly InstallationConfigIssue[];

  constructor(issues: readonly InstallationConfigIssue[]) {
    super(`InstallationConfig no válido:\n${issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n")}`);
    this.name = "InstallationConfigValidationError";
    this.issues = issues;
  }
}

const ROOT_KEYS = [
  "schemaVersion",
  "installationId",
  "companyName",
  "companySlug",
  "publicUrl",
  "branding",
  "paths",
  "connectors",
  "catalog",
  "usageLimits",
] as const;

const BRANDING_KEYS = ["productName", "logoPath", "faviconPath", "accentColor"] as const;

const PATH_KEYS = [
  "dataRoot",
  "companyContextRoot",
  "usersRoot",
  "sourceReadRoot",
  "publishWriteRoot",
  "backupsRoot",
] as const;

const CONNECTOR_KEYS = ["codexManagedAppAction", "gmail", "outlook", "composio", "companyMail", "instantly", "mail"] as const;
const CODEX_MANAGED_APP_ACTION_KEYS = ["appId", "server", "tool", "arguments", "correlationField", "readback"] as const;
const CODEX_MANAGED_APP_READBACK_KEYS = ["server", "tool", "arguments", "correlationArgument"] as const;
const MCP_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MICROSOFT_TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const MAX_CONFIG_STRING_LENGTH = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addUnknownKeyIssues(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  currentPath: string,
  issues: InstallationConfigIssue[],
) {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      issues.push({ path: `${currentPath}.${key}`, message: "campo desconocido" });
    }
  }
}

function readRequiredString(
  record: Record<string, unknown>,
  key: string,
  currentPath: string,
  issues: InstallationConfigIssue[],
  maximumLength = MAX_CONFIG_STRING_LENGTH,
) {
  const value = record[key];
  const issuePath = `${currentPath}.${key}`;
  if (typeof value !== "string") {
    issues.push({ path: issuePath, message: "debe ser un string" });
    return "";
  }
  if (value.length === 0) {
    issues.push({ path: issuePath, message: "no puede estar vacío" });
  } else if (value.trim() !== value) {
    issues.push({ path: issuePath, message: "no puede empezar ni terminar con espacios" });
  } else if (value.length > maximumLength) {
    issues.push({ path: issuePath, message: `supera el máximo de ${maximumLength} caracteres` });
  } else if (/\p{C}/u.test(value)) {
    issues.push({ path: issuePath, message: "contiene caracteres de control" });
  }
  return value;
}

function validateIdentifier(
  value: string,
  issuePath: string,
  issues: InstallationConfigIssue[],
) {
  if (value.length < 2 || value.length > 63 || !IDENTIFIER_PATTERN.test(value)) {
    issues.push({
      path: issuePath,
      message: "debe tener 2–63 caracteres en minúscula, empezar por letra y usar solo letras, números o guiones simples",
    });
  }
}

function validatePublicUrl(
  value: string,
  issuePath: string,
  issues: InstallationConfigIssue[],
) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    issues.push({ path: issuePath, message: "debe ser una URL absoluta válida" });
    return value;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    issues.push({ path: issuePath, message: "solo se permiten URLs HTTP o HTTPS" });
  }
  if (url.username || url.password) {
    issues.push({ path: issuePath, message: "no puede contener credenciales" });
  }
  if (url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    issues.push({ path: issuePath, message: "debe ser un origen sin path, query ni fragmento" });
  }
  const localHostnames = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (url.protocol === "http:" && !localHostnames.has(url.hostname)) {
    issues.push({ path: issuePath, message: "HTTP solo está permitido para localhost" });
  }
  return url.origin;
}

function validatePublicAssetPath(
  value: string,
  issuePath: string,
  issues: InstallationConfigIssue[],
) {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("%") ||
    path.posix.normalize(value) !== value
  ) {
    issues.push({
      path: issuePath,
      message: "debe ser un path público absoluto, normalizado y sin query, fragmento ni escapes",
    });
  }
}

function validateFilesystemPath(
  value: string,
  issuePath: string,
  issues: InstallationConfigIssue[],
) {
  if (!path.posix.isAbsolute(value)) {
    issues.push({ path: issuePath, message: "debe ser una ruta POSIX absoluta" });
    return;
  }
  if (value === "/") {
    issues.push({ path: issuePath, message: "no puede apuntar a la raíz del servidor" });
  }
  if (path.posix.normalize(value) !== value) {
    issues.push({ path: issuePath, message: "debe estar normalizada y no terminar en /" });
  }
}

function isStrictDescendant(parent: string, candidate: string) {
  const relative = path.posix.relative(parent, candidate);
  return relative.length > 0 && relative !== ".." && !relative.startsWith("../") && !path.posix.isAbsolute(relative);
}

function pathsOverlap(left: string, right: string) {
  return left === right || isStrictDescendant(left, right) || isStrictDescendant(right, left);
}

function parseBranding(
  value: unknown,
  issues: InstallationConfigIssue[],
): InstallationBranding {
  if (!isRecord(value)) {
    issues.push({ path: "$.branding", message: "debe ser un objeto" });
    return { productName: "", logoPath: "", faviconPath: "", accentColor: "" };
  }
  addUnknownKeyIssues(value, BRANDING_KEYS, "$.branding", issues);
  const productName = readRequiredString(value, "productName", "$.branding", issues, 80);
  const logoPath = readRequiredString(value, "logoPath", "$.branding", issues, 300);
  const faviconPath = readRequiredString(value, "faviconPath", "$.branding", issues, 300);
  const accentColor = readRequiredString(value, "accentColor", "$.branding", issues, 7);
  validatePublicAssetPath(logoPath, "$.branding.logoPath", issues);
  validatePublicAssetPath(faviconPath, "$.branding.faviconPath", issues);
  if (!HEX_COLOR_PATTERN.test(accentColor)) {
    issues.push({ path: "$.branding.accentColor", message: "debe usar el formato hexadecimal #RRGGBB" });
  }
  return { productName, logoPath, faviconPath, accentColor: accentColor.toLowerCase() };
}

function parsePaths(value: unknown, issues: InstallationConfigIssue[]): InstallationPaths {
  const emptyPaths: InstallationPaths = {
    dataRoot: "",
    companyContextRoot: "",
    usersRoot: "",
    sourceReadRoot: "",
    publishWriteRoot: "",
    backupsRoot: "",
  };
  if (!isRecord(value)) {
    issues.push({ path: "$.paths", message: "debe ser un objeto" });
    return emptyPaths;
  }
  addUnknownKeyIssues(value, PATH_KEYS, "$.paths", issues);
  const parsed = Object.fromEntries(PATH_KEYS.map((key) => {
    const item = readRequiredString(value, key, "$.paths", issues, 500);
    validateFilesystemPath(item, `$.paths.${key}`, issues);
    return [key, item];
  })) as InstallationPaths;

  const distinctPaths = new Map<string, string>();
  for (const key of PATH_KEYS) {
    const duplicate = distinctPaths.get(parsed[key]);
    if (duplicate) {
      issues.push({ path: `$.paths.${key}`, message: `debe ser diferente de paths.${duplicate}` });
    } else {
      distinctPaths.set(parsed[key], key);
    }
  }

  for (const key of ["companyContextRoot", "usersRoot", "backupsRoot"] as const) {
    if (parsed.dataRoot && parsed[key] && !isStrictDescendant(parsed.dataRoot, parsed[key])) {
      issues.push({ path: `$.paths.${key}`, message: "debe estar dentro de paths.dataRoot" });
    }
  }
  const privateDataRoots = ["companyContextRoot", "usersRoot", "backupsRoot"] as const;
  for (let leftIndex = 0; leftIndex < privateDataRoots.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < privateDataRoots.length; rightIndex += 1) {
      const leftKey = privateDataRoots[leftIndex];
      const rightKey = privateDataRoots[rightIndex];
      if (parsed[leftKey] && parsed[rightKey] && pathsOverlap(parsed[leftKey], parsed[rightKey])) {
        issues.push({
          path: `$.paths.${rightKey}`,
          message: `no puede solaparse con paths.${leftKey}`,
        });
      }
    }
  }
  for (const externalKey of ["sourceReadRoot", "publishWriteRoot"] as const) {
    if (parsed.dataRoot && parsed[externalKey] && pathsOverlap(parsed.dataRoot, parsed[externalKey])) {
      issues.push({
        path: `$.paths.${externalKey}`,
        message: "no puede solaparse con paths.dataRoot",
      });
    }
  }
  if (
    parsed.sourceReadRoot &&
    parsed.publishWriteRoot &&
    (isStrictDescendant(parsed.sourceReadRoot, parsed.publishWriteRoot) ||
      isStrictDescendant(parsed.publishWriteRoot, parsed.sourceReadRoot))
  ) {
    issues.push({
      path: "$.paths.publishWriteRoot",
      message: "no puede estar dentro de sourceReadRoot ni contenerlo",
    });
  }
  return parsed;
}

function parseStaticArguments(value: unknown, issuePath: string, issues: InstallationConfigIssue[]) {
  if (!isRecord(value)) {
    issues.push({ path: issuePath, message: "debe ser un objeto JSON estático" });
    return {};
  }
  let encoded = "";
  try {
    encoded = JSON.stringify(value);
  } catch {
    issues.push({ path: issuePath, message: "debe ser JSON serializable" });
    return {};
  }
  if (encoded.length > 16_384) {
    issues.push({ path: issuePath, message: "supera el máximo de 16384 bytes" });
  }
  const inspect = (candidate: unknown, currentPath: string): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => inspect(item, `${currentPath}[${index}]`));
      return;
    }
    if (!isRecord(candidate)) return;
    for (const [key, nested] of Object.entries(candidate)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (/authorization|cookie|password|secret|accesstoken|refreshtoken|apikey/.test(normalized)) {
        issues.push({ path: `${currentPath}.${key}`, message: "no se permiten claves de credenciales en argumentos estáticos" });
      }
      inspect(nested, `${currentPath}.${key}`);
    }
  };
  inspect(value, issuePath);
  return structuredClone(value);
}

function parseMcpIdentifier(value: unknown, issuePath: string, issues: InstallationConfigIssue[]) {
  if (typeof value !== "string" || !MCP_IDENTIFIER.test(value)) {
    issues.push({ path: issuePath, message: "debe ser un identificador MCP seguro" });
    return "";
  }
  return value;
}

function parseConnectors(value: unknown, issues: InstallationConfigIssue[]): InstallationConnectors | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issues.push({ path: "$.connectors", message: "debe ser un objeto" });
    return undefined;
  }
  addUnknownKeyIssues(value, CONNECTOR_KEYS, "$.connectors", issues);
  const action = value.codexManagedAppAction;
  let codexManagedAppAction: CodexManagedAppActionConfig | undefined;
  if (action !== undefined) {
    if (!isRecord(action)) {
      issues.push({ path: "$.connectors.codexManagedAppAction", message: "debe ser un objeto" });
    } else {
      addUnknownKeyIssues(action, CODEX_MANAGED_APP_ACTION_KEYS, "$.connectors.codexManagedAppAction", issues);
      const readbackValue = action.readback;
      if (!isRecord(readbackValue)) {
        issues.push({ path: "$.connectors.codexManagedAppAction.readback", message: "debe ser un objeto" });
      } else {
        addUnknownKeyIssues(readbackValue, CODEX_MANAGED_APP_READBACK_KEYS, "$.connectors.codexManagedAppAction.readback", issues);
        const readback = {
          server: parseMcpIdentifier(readbackValue.server, "$.connectors.codexManagedAppAction.readback.server", issues),
          tool: parseMcpIdentifier(readbackValue.tool, "$.connectors.codexManagedAppAction.readback.tool", issues),
          arguments: parseStaticArguments(readbackValue.arguments, "$.connectors.codexManagedAppAction.readback.arguments", issues),
          correlationArgument: parseMcpIdentifier(readbackValue.correlationArgument, "$.connectors.codexManagedAppAction.readback.correlationArgument", issues),
        };
        if (Object.prototype.hasOwnProperty.call(readback.arguments, readback.correlationArgument)) {
          issues.push({ path: "$.connectors.codexManagedAppAction.readback.arguments", message: "no puede fijar el argumento de correlación" });
        }
        codexManagedAppAction = {
          appId: parseMcpIdentifier(action.appId, "$.connectors.codexManagedAppAction.appId", issues),
          server: parseMcpIdentifier(action.server, "$.connectors.codexManagedAppAction.server", issues),
          tool: parseMcpIdentifier(action.tool, "$.connectors.codexManagedAppAction.tool", issues),
          arguments: parseStaticArguments(action.arguments, "$.connectors.codexManagedAppAction.arguments", issues),
          correlationField: parseMcpIdentifier(action.correlationField, "$.connectors.codexManagedAppAction.correlationField", issues),
          readback,
        };
      }
    }
  }
  let mail: InstallationConnectors["mail"];
  if (value.mail !== undefined) {
    if (!isRecord(value.mail)) issues.push({ path: "$.connectors.mail", message: "debe ser un objeto" });
    else {
      addUnknownKeyIssues(value.mail, ["enabled", "provider"], "$.connectors.mail", issues);
      if (typeof value.mail.enabled !== "boolean" || value.mail.provider !== "nominalia") issues.push({ path: "$.connectors.mail", message: "requiere enabled boolean y provider nominalia" });
      else mail = { enabled: value.mail.enabled, provider: "nominalia" };
    }
  }
  let companyMail: CompanyMailConnectorConfig | undefined;
  if (value.companyMail !== undefined) {
    const mail = value.companyMail;
    const dns = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/u;
    if (!isRecord(mail)) issues.push({ path: "$.connectors.companyMail", message: "debe ser un objeto" });
    else {
      addUnknownKeyIssues(mail, ["enabled", "host", "emailDomain"], "$.connectors.companyMail", issues);
      if (typeof mail.enabled !== "boolean" || typeof mail.host !== "string" || !dns.test(mail.host) ||
          mail.host.endsWith(".localhost") || mail.host.endsWith(".internal") || mail.host.endsWith(".local") ||
          typeof mail.emailDomain !== "string" || !dns.test(mail.emailDomain)) {
        issues.push({ path: "$.connectors.companyMail", message: "requiere enabled, host IMAPS DNS exacto y emailDomain normalizados" });
      } else companyMail = { enabled: mail.enabled, host: mail.host, emailDomain: mail.emailDomain };
    }
  }
  let gmail: GmailConnectorConfig | undefined;
  if (value.gmail !== undefined) {
    if (!isRecord(value.gmail)) {
      issues.push({ path: "$.connectors.gmail", message: "debe ser un objeto" });
    } else {
      addUnknownKeyIssues(value.gmail, ["enabled"], "$.connectors.gmail", issues);
      if (typeof value.gmail.enabled !== "boolean") {
        issues.push({ path: "$.connectors.gmail.enabled", message: "debe ser boolean" });
      } else {
        gmail = { enabled: value.gmail.enabled };
      }
    }
  }
  let outlook: OutlookConnectorConfig | undefined;
  if (value.outlook !== undefined) {
    if (!isRecord(value.outlook)) {
      issues.push({ path: "$.connectors.outlook", message: "debe ser un objeto" });
    } else {
      addUnknownKeyIssues(value.outlook, ["enabled", "tenantId"], "$.connectors.outlook", issues);
      if (typeof value.outlook.enabled !== "boolean") issues.push({ path: "$.connectors.outlook.enabled", message: "debe ser boolean" });
      if (value.outlook.tenantId !== undefined && (typeof value.outlook.tenantId !== "string" || !MICROSOFT_TENANT_ID.test(value.outlook.tenantId))) {
        issues.push({ path: "$.connectors.outlook.tenantId", message: "debe ser el UUID exacto del tenant de Microsoft Entra" });
      } else if (typeof value.outlook.enabled === "boolean") {
        outlook = {
          enabled: value.outlook.enabled,
          ...(typeof value.outlook.tenantId === "string" ? { tenantId: value.outlook.tenantId.toLowerCase() } : {}),
        };
      }
    }
  }
  let instantly: InstallationConnectors["instantly"];
  if (value.instantly !== undefined) {
    const candidate = value.instantly;
    if (!isRecord(candidate) || Object.keys(candidate).sort().join() !== "enabled,workspaceId" ||
        typeof candidate.enabled !== "boolean" || typeof candidate.workspaceId !== "string" || !MICROSOFT_TENANT_ID.test(candidate.workspaceId)) {
      issues.push({ path: "$.connectors.instantly", message: "requiere enabled y UUID exacto del workspace; sin credenciales" });
    } else instantly = { enabled: candidate.enabled, workspaceId: candidate.workspaceId.toLowerCase() };
  }
  let composio: InstallationConnectors["composio"];
  if (value.composio !== undefined) {
    const candidate = value.composio;
    if (!isRecord(candidate) || Object.keys(candidate).join() !== "toolkits" ||
        !Array.isArray(candidate.toolkits) || candidate.toolkits.length > 40 ||
        !candidate.toolkits.every(isComposioToolkitConfig) ||
        new Set(candidate.toolkits.map(t => t.slug.replaceAll("_", "-"))).size !== candidate.toolkits.length) {
      issues.push({ path: "$.connectors.composio", message: "requiere toolkits revisados, auth config, scopes y herramientas de lectura con versión fija" });
    } else composio = { toolkits: candidate.toolkits };
  }
  if (!codexManagedAppAction && !gmail && !outlook && !composio && !companyMail && !instantly && !mail) {
    issues.push({ path: "$.connectors", message: "debe configurar al menos un conector" });
    return undefined;
  }
  return { ...(mail ? { mail } : {}), ...(instantly ? { instantly } : {}), ...(companyMail ? { companyMail } : {}), ...(composio ? { composio } : {}), ...(codexManagedAppAction ? { codexManagedAppAction } : {}), ...(gmail ? { gmail } : {}), ...(outlook ? { outlook } : {}) };
}

function parseCatalog(value: unknown, issues: InstallationConfigIssue[]): InstallationCatalog | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) { issues.push({ path: "$.catalog", message: "debe ser un objeto" }); return undefined; }
  addUnknownKeyIssues(value, ["graphikAIManagedSkills"], "$.catalog", issues);
  if (!Array.isArray(value.graphikAIManagedSkills) || value.graphikAIManagedSkills.length > 80) {
    issues.push({ path: "$.catalog.graphikAIManagedSkills", message: "debe ser una lista de hasta 80 skills" });
    return undefined;
  }
  const skills = value.graphikAIManagedSkills.map((candidate, index) => {
    const current = `$.catalog.graphikAIManagedSkills[${index}]`;
    if (!isRecord(candidate)) { issues.push({ path: current, message: "debe ser un objeto" }); return { id: "", label: "" }; }
    addUnknownKeyIssues(candidate, ["id", "label"], current, issues);
    return {
      id: parseMcpIdentifier(candidate.id, `${current}.id`, issues),
      label: readRequiredString(candidate, "label", current, issues, 120),
    };
  });
  if (new Set(skills.map(({ id }) => id)).size !== skills.length) issues.push({ path: "$.catalog.graphikAIManagedSkills", message: "los ids deben ser únicos" });
  return { graphikAIManagedSkills: skills };
}

function freezeInstallationConfig(config: InstallationConfig): Readonly<InstallationConfig> {
  Object.freeze(config.branding);
  Object.freeze(config.paths);
  if (config.usageLimits) Object.freeze(config.usageLimits);
  if (config.connectors) {
    if (config.connectors.codexManagedAppAction) {
      Object.freeze(config.connectors.codexManagedAppAction.arguments);
      Object.freeze(config.connectors.codexManagedAppAction.readback.arguments);
      Object.freeze(config.connectors.codexManagedAppAction.readback);
      Object.freeze(config.connectors.codexManagedAppAction);
    }
    if (config.connectors.instantly) Object.freeze(config.connectors.instantly);
    if (config.connectors.gmail) Object.freeze(config.connectors.gmail);
    if (config.connectors.mail) Object.freeze(config.connectors.mail);
    if (config.connectors.outlook) Object.freeze(config.connectors.outlook);
    if (config.connectors.composio) {
      for (const toolkit of config.connectors.composio.toolkits) {
        toolkit.readTools.forEach(Object.freeze);
        Object.freeze(toolkit.readTools); Object.freeze(toolkit.scopes); Object.freeze(toolkit);
      }
      Object.freeze(config.connectors.composio.toolkits); Object.freeze(config.connectors.composio);
    }
    Object.freeze(config.connectors);
  }
  if (config.catalog) {
    for (const skill of config.catalog.graphikAIManagedSkills) Object.freeze(skill);
    Object.freeze(config.catalog.graphikAIManagedSkills);
    Object.freeze(config.catalog);
  }
  return Object.freeze(config);
}

export function parseInstallationConfig(value: unknown): Readonly<InstallationConfig> {
  const issues: InstallationConfigIssue[] = [];
  if (!isRecord(value)) {
    throw new InstallationConfigValidationError([{ path: "$", message: "debe ser un objeto JSON" }]);
  }
  addUnknownKeyIssues(value, ROOT_KEYS, "$", issues);

  if (value.schemaVersion !== INSTALLATION_CONFIG_SCHEMA_VERSION) {
    issues.push({
      path: "$.schemaVersion",
      message: `debe ser ${INSTALLATION_CONFIG_SCHEMA_VERSION}`,
    });
  }
  const installationId = readRequiredString(value, "installationId", "$", issues, 63);
  const companyName = readRequiredString(value, "companyName", "$", issues, 120);
  const companySlug = readRequiredString(value, "companySlug", "$", issues, 63);
  const rawPublicUrl = readRequiredString(value, "publicUrl", "$", issues, 300);
  validateIdentifier(installationId, "$.installationId", issues);
  validateIdentifier(companySlug, "$.companySlug", issues);
  const publicUrl = validatePublicUrl(rawPublicUrl, "$.publicUrl", issues);
  const branding = parseBranding(value.branding, issues);
  const paths = parsePaths(value.paths, issues);
  const connectors = parseConnectors(value.connectors, issues);
  const catalog = parseCatalog(value.catalog, issues);
  let usageLimits: InstallationConfig["usageLimits"];
  if (value.usageLimits !== undefined) {
    if (!isRecord(value.usageLimits)) {
      issues.push({ path: "$.usageLimits", message: "debe ser un objeto" });
    } else {
      addUnknownKeyIssues(value.usageLimits, ["weeklyTokens", "timeZone", "unlimitedUntil"], "$.usageLimits", issues);
      const { weeklyTokens, timeZone, unlimitedUntil } = value.usageLimits;
      if (typeof weeklyTokens !== "number" || !Number.isSafeInteger(weeklyTokens) || weeklyTokens < 1) {
        issues.push({ path: "$.usageLimits.weeklyTokens", message: "debe ser un entero positivo seguro" });
      }
      if (timeZone !== "Europe/Madrid") {
        issues.push({ path: "$.usageLimits.timeZone", message: "debe ser Europe/Madrid" });
      }
      const normalizedUnlimitedUntil = typeof unlimitedUntil === "string" && Number.isFinite(Date.parse(unlimitedUntil))
        ? new Date(unlimitedUntil).toISOString()
        : null;
      if (unlimitedUntil !== undefined && normalizedUnlimitedUntil !== unlimitedUntil) {
        issues.push({ path: "$.usageLimits.unlimitedUntil", message: "debe ser una fecha ISO UTC canónica" });
      }
      if (typeof weeklyTokens === "number" && Number.isSafeInteger(weeklyTokens) && weeklyTokens > 0 && timeZone === "Europe/Madrid" &&
          (unlimitedUntil === undefined || normalizedUnlimitedUntil === unlimitedUntil)) {
        usageLimits = { weeklyTokens, timeZone, ...(normalizedUnlimitedUntil ? { unlimitedUntil: normalizedUnlimitedUntil } : {}) };
      }
    }
  }

  if (issues.length > 0) {
    throw new InstallationConfigValidationError(issues);
  }
  return freezeInstallationConfig({
    schemaVersion: INSTALLATION_CONFIG_SCHEMA_VERSION,
    installationId,
    companyName,
    companySlug,
    publicUrl,
    branding,
    paths,
    ...(connectors ? { connectors } : {}),
    ...(catalog ? { catalog } : {}),
    ...(usageLimits ? { usageLimits } : {}),
  });
}
