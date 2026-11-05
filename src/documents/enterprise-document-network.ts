import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { InstallationConfig } from "@/config/installation-schema";
import type { ResolvedPermissions } from "@/permissions";
import { atomicWriteFile } from "@/storage";
import { readRegularFileWithin } from "@/security/safe-file";

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_DEPTH = 12;
const MAX_ENTRIES = 10_000;
const MAX_INDEXED_BYTES = 512 * 1024;
const MAX_QUERY_LENGTH = 200;
const MAX_READ_BYTES = 512 * 1024;
const SENSITIVE_FILE_NAME = /(?:^|[._-])(?:\.env|secret|secrets|credential|credentials|token|tokens|password|passwd|private[-_.]?key|docker\.sock)(?:$|[._-])/iu;
const CREDENTIAL_SHAPED_CONTENT = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*|\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|password)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{16,}/iu;

export type EnterpriseDocumentScope = "company" | "department" | "project" | "private";

export type EnterpriseDocumentRoot = Readonly<{
  scope: EnterpriseDocumentScope;
  scopeId: string | null;
  path: string;
  readOnly: boolean;
}>;

export type EnterpriseDocumentSearchResult = Readonly<{
  scope: EnterpriseDocumentScope;
  path: string;
  size: number;
  sha256: string;
  provenance: Readonly<{
    installationId: string;
    departmentId: string | null;
    projectId: string | null;
    userId: string | null;
  }>;
}>;

export type EnterpriseDocumentReadResult = EnterpriseDocumentSearchResult & Readonly<{ content: string }>;

export class EnterpriseDocumentNetworkError extends Error {
  constructor(readonly code: string, message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "EnterpriseDocumentNetworkError";
  }
}

function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertId(value: string, label: string) {
  if (!USER_ID.test(value)) throw new EnterpriseDocumentNetworkError("DOCUMENT_NETWORK_ID_INVALID", `${label} is invalid.`);
  return value;
}

function scopeRule(scope: EnterpriseDocumentScope, operation: "read" | "write") {
  return `documents.${scope}.${operation}`;
}

function permissionAllows(
  permissions: ResolvedPermissions,
  scope: EnterpriseDocumentScope,
  operation: "read" | "write",
) {
  const action = operation === "read" ? "consult" : "execute";
  const ruleIds = [scopeRule(scope, operation), `documents.${operation}`];
  const matches = permissions.rules.filter((rule) => rule.action === action && ruleIds.includes(rule.ruleId));
  if (matches.some((rule) => rule.effect === "deny")) return false;
  return matches.some((rule) => rule.effect === "allow");
}

function safeRelativePath(value: string) {
  if (!value || value.length > 1_024 || path.posix.isAbsolute(value) || value.includes("\\") || path.posix.normalize(value) !== value || /\p{C}/u.test(value)) {
    throw new EnterpriseDocumentNetworkError("DOCUMENT_NETWORK_PATH_INVALID", "Document path is invalid.");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith(".") || SENSITIVE_FILE_NAME.test(segment))) {
    throw new EnterpriseDocumentNetworkError("DOCUMENT_NETWORK_SENSITIVE_PATH", "Document path is not available to the assistant.");
  }
  return segments.join(path.sep);
}

function decodeAuthorizedText(value: Buffer, label: string) {
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (error) {
    throw new EnterpriseDocumentNetworkError("DOCUMENT_NETWORK_TEXT_INVALID", `${label} is not valid UTF-8 text.`, { cause: error });
  }
  if (/\p{C}/u.test(content.replace(/[\t\n\r]/gu, "")) || CREDENTIAL_SHAPED_CONTENT.test(content)) {
    throw new EnterpriseDocumentNetworkError("DOCUMENT_NETWORK_SECRET_REJECTED", "Credential-shaped content is not available to the assistant.");
  }
  return content;
}

async function secureDirectory(root: string, target: string) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!inside(resolvedRoot, resolvedTarget)) {
    throw new EnterpriseDocumentNetworkError("DOCUMENT_NETWORK_PATH_ESCAPE", "Document root escapes its installation data root.");
  }
  await mkdir(resolvedRoot, { recursive: true, mode: 0o700 });
  const rootMetadata = await lstat(resolvedRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new EnterpriseDocumentNetworkError("DOCUMENT_NETWORK_SYMLINK_REJECTED", "Document network root must be a real directory.");
  }
  const canonicalRoot = await realpath(resolvedRoot);
  let current = resolvedRoot;
  const relative = path.relative(resolvedRoot, resolvedTarget);
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    await mkdir(current, { recursive: true, mode: 0o700 });
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new EnterpriseDocumentNetworkError("DOCUMENT_NETWORK_SYMLINK_REJECTED", "Document network directories must not be symbolic links.");
    }
    if (!inside(canonicalRoot, await realpath(current))) {
      throw new EnterpriseDocumentNetworkError("DOCUMENT_NETWORK_PATH_ESCAPE", "Document network resolves outside its installation root.");
    }
  }
}

/**
 * The network lives below dataRoot, never beside it: each installation therefore
 * gets a persistent, volume-backed root without handing a worker its dataRoot,
 * credentials, configuration or any host path.
 */
export function enterpriseDocumentNetworkRoot(config: Readonly<InstallationConfig>) {
  return path.join(path.resolve(config.paths.dataRoot), "enterprise-documents");
}

export class EnterpriseDocumentNetwork {
  readonly root: string;
  private readonly authorizedRoots = new WeakSet<EnterpriseDocumentRoot>();

  constructor(readonly config: Readonly<InstallationConfig>) {
    this.root = enterpriseDocumentNetworkRoot(config);
  }

  companyRoot() {
    return path.join(this.root, "company", "shared");
  }

  departmentRoot(departmentId: string) {
    return path.join(this.root, "departments", assertId(departmentId, "departmentId"), "shared");
  }

  projectRoot(projectId: string) {
    return path.join(this.root, "projects", assertId(projectId, "projectId"), "shared");
  }

  privateRoot(userId: string) {
    return path.join(this.root, "users", assertId(userId, "userId"), "private");
  }

  async provision(input: { userId: string; projectId: string; departmentIds?: readonly string[] }) {
    assertId(input.userId, "userId");
    assertId(input.projectId, "projectId");
    const departmentIds = [...new Set(input.departmentIds ?? [])].map((id) => assertId(id, "departmentId"));
    for (const [scope, directory, provenance] of [
      ["company", this.companyRoot(), { installationId: this.config.installationId, departmentId: null, projectId: null, userId: null }],
      ...departmentIds.map((departmentId) => ["department", this.departmentRoot(departmentId), {
        installationId: this.config.installationId,
        departmentId,
        projectId: null,
        userId: null,
      }] as const),
      ["project", this.projectRoot(input.projectId), { installationId: this.config.installationId, departmentId: null, projectId: input.projectId, userId: null }],
      ["private", this.privateRoot(input.userId), { installationId: this.config.installationId, departmentId: null, projectId: null, userId: input.userId }],
    ] as const) {
      await secureDirectory(this.root, directory);
      await atomicWriteFile(path.join(directory, ".aibrain-document-scope.json"), `${JSON.stringify({
        schemaVersion: 1,
        scope,
        ...provenance,
      }, null, 2)}\n`, { mode: 0o600 });
    }
  }

  async rootsForTurn(input: {
    userId: string;
    projectId: string;
    departmentIds?: readonly string[];
    permissions: ResolvedPermissions;
  }) {
    assertId(input.userId, "userId");
    assertId(input.projectId, "projectId");
    if (input.permissions.installationId !== this.config.installationId ||
        input.permissions.userId !== input.userId || input.permissions.projectId !== input.projectId) {
      throw new EnterpriseDocumentNetworkError("DOCUMENT_NETWORK_PERMISSION_BINDING", "Document network permissions do not belong to this turn.");
    }
    const departmentIds = [...new Set(input.departmentIds ?? [])].map((id) => assertId(id, "departmentId"));
    await this.provision({ ...input, departmentIds });
    const roots: EnterpriseDocumentRoot[] = [];
    for (const [scope, scopeId, directory] of [
      ["company", null, this.companyRoot()],
      ...departmentIds.map((departmentId) => ["department", departmentId, this.departmentRoot(departmentId)] as const),
      ["project", input.projectId, this.projectRoot(input.projectId)],
      ["private", input.userId, this.privateRoot(input.userId)],
    ] as const) {
      if (!permissionAllows(input.permissions, scope, "read")) continue;
      const root = Object.freeze({
        scope,
        scopeId,
        path: directory,
        readOnly: !permissionAllows(input.permissions, scope, "write"),
      });
      this.authorizedRoots.add(root);
      roots.push(root);
    }
    return Object.freeze(roots);
  }

  private async validateAuthorizedRoot(root: EnterpriseDocumentRoot) {
    if (!this.authorizedRoots.has(root)) {
      throw new EnterpriseDocumentNetworkError("DOCUMENT_NETWORK_ROOT_NOT_AUTHORIZED", "Document root was not authorized for this turn.");
    }
    const [networkMetadata, rootMetadata] = await Promise.all([lstat(this.root), lstat(root.path)]);
    if (!networkMetadata.isDirectory() || networkMetadata.isSymbolicLink() || !rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      throw new EnterpriseDocumentNetworkError("DOCUMENT_NETWORK_SYMLINK_REJECTED", "Document root must remain a real directory.");
    }
    const [canonicalNetwork, canonicalRoot] = await Promise.all([realpath(this.root), realpath(root.path)]);
    if (!inside(canonicalNetwork, canonicalRoot) || canonicalNetwork === canonicalRoot) {
      throw new EnterpriseDocumentNetworkError("DOCUMENT_NETWORK_PATH_ESCAPE", "Document root escapes its installation network.");
    }
    return canonicalRoot;
  }

  private provenance(root: EnterpriseDocumentRoot) {
    return Object.freeze({
      installationId: this.config.installationId,
      departmentId: root.scope === "department" ? root.scopeId : null,
      projectId: root.scope === "project" ? root.scopeId : null,
      userId: root.scope === "private" ? root.scopeId : null,
    });
  }

  async validateSyncRoots(roots: readonly EnterpriseDocumentRoot[]) {
    for (const root of roots) await this.validateAuthorizedRoot(root);
  }

  async validateSyncRead(input: { roots: readonly EnterpriseDocumentRoot[]; scope: EnterpriseDocumentScope; scopeId?: string | null; path: string }) {
    safeRelativePath(input.path);
    const root = input.roots.find((candidate) => candidate.scope === input.scope &&
      (input.scope !== "department" || candidate.scopeId === input.scopeId));
    if (!root) throw new EnterpriseDocumentNetworkError("DOCUMENT_NETWORK_SCOPE_DENIED", "Document scope is not authorized for this turn.");
    await this.validateAuthorizedRoot(root);
  }

  async read(input: { roots: readonly EnterpriseDocumentRoot[]; scope: EnterpriseDocumentScope; scopeId?: string | null; path: string }) {
    const relativePath = safeRelativePath(input.path);
    const root = input.roots.find((candidate) => candidate.scope === input.scope && (
      input.scope !== "department" || candidate.scopeId === input.scopeId
    ));
    if (!root) {
      throw new EnterpriseDocumentNetworkError("DOCUMENT_NETWORK_SCOPE_DENIED", "Document scope is not authorized for this turn.");
    }
    const canonicalRoot = await this.validateAuthorizedRoot(root);
    const candidate = path.resolve(canonicalRoot, relativePath);
    if (!inside(canonicalRoot, candidate) || candidate === canonicalRoot) {
      throw new EnterpriseDocumentNetworkError("DOCUMENT_NETWORK_PATH_ESCAPE", "Document path escapes its authorized scope.");
    }
    const metadata = await lstat(candidate);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_READ_BYTES) {
      throw new EnterpriseDocumentNetworkError("DOCUMENT_NETWORK_FILE_UNAVAILABLE", "Document is not a bounded regular file.");
    }
    const canonicalFile = await realpath(candidate);
    if (!inside(canonicalRoot, canonicalFile) || canonicalFile === canonicalRoot) {
      throw new EnterpriseDocumentNetworkError("DOCUMENT_NETWORK_PATH_ESCAPE", "Document resolves outside its authorized scope.");
    }
    const contents = await readRegularFileWithin(canonicalRoot, relativePath, MAX_READ_BYTES);
    return Object.freeze({
      scope: root.scope,
      path: input.path,
      size: contents.length,
      sha256: createHash("sha256").update(contents).digest("hex"),
      provenance: this.provenance(root),
      content: decodeAuthorizedText(contents, input.path),
    }) satisfies EnterpriseDocumentReadResult;
  }

  async search(input: { roots: readonly EnterpriseDocumentRoot[]; query: string; limit?: number }) {
    const query = input.query.trim().toLocaleLowerCase();
    if (!query || query.length > MAX_QUERY_LENGTH || /[\0/\\]/u.test(query)) {
      throw new EnterpriseDocumentNetworkError("DOCUMENT_NETWORK_QUERY_INVALID", "Document search query is invalid.");
    }
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new EnterpriseDocumentNetworkError("DOCUMENT_NETWORK_QUERY_INVALID", "Document search limit is invalid.");
    }
    const results: EnterpriseDocumentSearchResult[] = [];
    for (const root of input.roots) {
      const canonicalRoot = await this.validateAuthorizedRoot(root);
      const visit = async (directory: string, depth: number): Promise<void> => {
        if (depth > MAX_DEPTH || results.length >= limit) return;
        const entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (results.length >= limit || entry.name.startsWith(".") || SENSITIVE_FILE_NAME.test(entry.name)) continue;
          const candidate = path.join(directory, entry.name);
          const metadata = await lstat(candidate);
          if (metadata.isSymbolicLink()) throw new EnterpriseDocumentNetworkError("DOCUMENT_NETWORK_SYMLINK_REJECTED", "Document search refuses symbolic links.");
          if (metadata.isDirectory()) {
            if (!inside(canonicalRoot, await realpath(candidate))) throw new EnterpriseDocumentNetworkError("DOCUMENT_NETWORK_PATH_ESCAPE", "Document directory escapes its scope.");
            await visit(candidate, depth + 1);
            continue;
          }
          if (!metadata.isFile() || metadata.size > MAX_INDEXED_BYTES) continue;
          const relative = path.relative(canonicalRoot, candidate).split(path.sep).join("/");
          const contents = await readRegularFileWithin(canonicalRoot, relative, MAX_INDEXED_BYTES);
          let text: string;
          try {
            text = decodeAuthorizedText(contents, relative);
          } catch (error) {
            if (error instanceof EnterpriseDocumentNetworkError && (error.code === "DOCUMENT_NETWORK_TEXT_INVALID" || error.code === "DOCUMENT_NETWORK_SECRET_REJECTED")) continue;
            throw error;
          }
          const haystack = `${relative}\n${text.slice(0, MAX_INDEXED_BYTES)}`.toLocaleLowerCase();
          if (!haystack.includes(query)) continue;
          results.push(Object.freeze({
            scope: root.scope,
            path: relative,
            size: metadata.size,
            sha256: createHash("sha256").update(contents).digest("hex"),
            provenance: this.provenance(root),
          }));
          if (results.length > MAX_ENTRIES) throw new EnterpriseDocumentNetworkError("DOCUMENT_NETWORK_LIMIT", "Document network contains too many matching files.");
        }
      };
      await visit(canonicalRoot, 0);
    }
    return Object.freeze(results);
  }
}
