import "server-only";

import type { AuthSession } from "@/auth/types";
import { loadInstallationConfig } from "@/config/installation";
import type { InstallationConfig } from "@/config/installation-schema";
import {
  FileLibraryResourceLocationIndex,
  LibraryResourceLocationNotFoundError,
  type LibraryResourceKind,
} from "@/library/resource-location-index";
import { resolveProjectAccess, resolveThreadAccess } from "@/workbench/shared-access";

export class LibraryResourceForbiddenError extends Error {}

export function resourceLocationIndexForInstallation(
  installation: Pick<InstallationConfig, "installationId" | "paths">,
) {
  return new FileLibraryResourceLocationIndex({
    dataRoot: installation.paths.dataRoot,
    installationId: installation.installationId,
  });
}

export async function installationForLibraryResource(session: AuthSession) {
  const installation = await loadInstallationConfig();
  if (session.provider !== "local" || session.tenant.id !== installation.installationId) {
    throw new LibraryResourceForbiddenError("La sesión no pertenece a esta instalación.");
  }
  return installation;
}

export async function resolveThreadLibraryResource(
  session: AuthSession,
  input: { kind: LibraryResourceKind; resourceId: string; threadId: string },
) {
  const installation = await installationForLibraryResource(session);
  // Authorization is resolved before the resource index can select a private
  // storage owner. No foreign user root is touched during this step.
  const access = await resolveThreadAccess(session, input.threadId);
  const index = resourceLocationIndexForInstallation(installation);
  const location = await index.resolve(input.kind, input.resourceId, {
    projectId: access.project.id,
    threadId: access.thread.id,
  });
  return { installation, access, index, location };
}

export async function resolveProjectLibraryResource(
  session: AuthSession,
  input: { kind: LibraryResourceKind; resourceId: string; projectId: string },
) {
  const installation = await installationForLibraryResource(session);
  const access = await resolveProjectAccess(session, input.projectId);
  const index = resourceLocationIndexForInstallation(installation);
  const location = await index.resolve(input.kind, input.resourceId, {
    projectId: access.project.id,
  });
  return { installation, access, index, location };
}

/**
 * Advanced-artifact URLs contain only their opaque artifact id. The first
 * index read discovers its non-secret project/thread binding; authorization
 * is then resolved, and the binding is re-resolved before any user root is
 * opened. Revocation between those reads therefore fails closed.
 */
export async function resolveAdvancedArtifactResource(
  session: AuthSession,
  artifactId: string,
) {
  const installation = await installationForLibraryResource(session);
  const index = resourceLocationIndexForInstallation(installation);
  const binding = await index.binding("advanced-artifact", artifactId);
  if (!binding) throw new LibraryResourceLocationNotFoundError("Artefacto no encontrado.");
  const access = await resolveThreadAccess(session, binding.threadId);
  const location = await index.resolve("advanced-artifact", artifactId, {
    projectId: access.project.id,
    threadId: access.thread.id,
  });
  if (location.storageOwnerId !== binding.storageOwnerId || location.sha256 !== binding.sha256 ||
      location.size !== binding.size) {
    throw new LibraryResourceLocationNotFoundError("Artefacto no encontrado.");
  }
  return { installation, access, index, location };
}

/**
 * Generated documents are immutable server blobs bound to one source thread.
 * Resolve the thread ACL before returning the owning user's storage location;
 * the caller-provided thread id must match the durable binding exactly.
 */
export async function resolveGeneratedDocumentResource(
  session: AuthSession,
  input: { artifactId: string; threadId: string },
) {
  const installation = await installationForLibraryResource(session);
  const index = resourceLocationIndexForInstallation(installation);
  const binding = await index.binding("generated-document", input.artifactId);
  if (!binding || binding.threadId !== input.threadId) {
    throw new LibraryResourceLocationNotFoundError("Documento no encontrado.");
  }
  const access = await resolveThreadAccess(session, input.threadId);
  const location = await index.resolve("generated-document", input.artifactId, {
    projectId: access.project.id,
    threadId: access.thread.id,
  });
  if (location.storageOwnerId !== binding.storageOwnerId || location.sha256 !== binding.sha256 ||
      location.size !== binding.size || location.relativePath !== binding.relativePath) {
    throw new LibraryResourceLocationNotFoundError("Documento no encontrado.");
  }
  return { installation, access, index, location };
}

export function assertLibraryResourceWritable(access: { role: "owner" | "editor" | "viewer" }) {
  if (access.role === "viewer") {
    throw new LibraryResourceForbiddenError("Este proyecto compartido es de solo lectura.");
  }
}
