import "server-only";

import path from "node:path";
import type { AuthSession } from "@/auth/types";
import type { CreateAdvancedArtifactInput, CreateAdvancedArtifactVersionInput } from "@/artifacts/contracts";
import { visualizationSpecFromMarkdown } from "@/artifacts/contracts";
import { contentHash } from "@/artifacts/content-hash";
import { internalSiteFromMessage, renderArtifactHtml, sanitizeInternalSiteHtml } from "@/artifacts/rendering";
import { AdvancedArtifactValidationError, FileAdvancedArtifactStore } from "@/artifacts/store";
import { loadInstallationConfig } from "@/config/installation";
import type { ChatMessage } from "@/lib/chat-contract";
import {
  assertLibraryResourceWritable,
  resolveAdvancedArtifactResource,
  resourceLocationIndexForInstallation,
} from "@/library/server-resource-access";
import { getThread, loadWorkbench } from "@/workbench/store";
import { resolveThreadAccess } from "@/workbench/shared-access";

export async function advancedArtifactStoreForSession(session: AuthSession) {
  const installation = await loadInstallationConfig();
  if (session.provider === "local" && session.tenant.id !== installation.installationId) {
    throw new AdvancedArtifactValidationError("La sesión no pertenece a esta instalación.");
  }
  if (session.provider === "local") {
    return new FileAdvancedArtifactStore({
      installationId: installation.installationId,
      rootDirectory: installation.paths.usersRoot,
    });
  }
  return new FileAdvancedArtifactStore({
    installationId: installation.installationId,
    rootDirectory: path.join(installation.paths.dataRoot, "demo-advanced-artifacts", session.tenant.id),
    autoProvisionUsers: true,
  });
}

async function sourceMessage(session: AuthSession, threadId: string, messageId: string) {
  if (session.provider !== "local") {
    const thread = await getThread(session, threadId);
    const message = thread.messages.find((candidate) => candidate.id === messageId);
    if (!message || message.role !== "assistant" || message.status !== "complete" || !message.content.trim()) {
      throw new AdvancedArtifactValidationError("Selecciona una respuesta completa con contenido real.");
    }
    return { thread, message, access: null };
  }
  const access = await resolveThreadAccess(session, threadId);
  assertLibraryResourceWritable(access);
  const thread = access.thread;
  const message = thread.messages.find((candidate) => candidate.id === messageId);
  if (!message || message.role !== "assistant" || message.status !== "complete" || !message.content.trim()) {
    throw new AdvancedArtifactValidationError("Selecciona una respuesta completa con contenido real.");
  }
  return { thread, message, access };
}

function source(thread: Awaited<ReturnType<typeof getThread>>, message: ChatMessage) {
  return {
    projectId: thread.projectId,
    threadId: thread.id,
    messageId: message.id,
    messageSha256: contentHash(message.content),
  };
}

function content(kind: "visualization" | "internal-site", message: ChatMessage, input: { spec?: CreateAdvancedArtifactInput["spec"]; html?: string }, title: string) {
  if (kind === "visualization") {
    const spec = input.spec ?? visualizationSpecFromMarkdown(message.content, title);
    if (!spec) {
      throw new AdvancedArtifactValidationError("Esta respuesta no contiene una tabla numérica que se pueda visualizar sin inventar datos.");
    }
    return { kind, spec } as const;
  }
  const html = input.html === undefined ? internalSiteFromMessage(message.content) : sanitizeInternalSiteHtml(input.html);
  if (!html.trim()) throw new AdvancedArtifactValidationError("El contenido del sitio interno queda vacío después del saneado.");
  return { kind, html } as const;
}

export async function createAdvancedArtifact(session: AuthSession, input: CreateAdvancedArtifactInput) {
  const { thread, message } = await sourceMessage(session, input.threadId, input.messageId);
  const store = await advancedArtifactStoreForSession(session);
  const created = await store.create(session.user.id, {
    title: input.title.trim(), source: source(thread, message),
    content: content(input.kind, message, input, input.title.trim()),
  });
  if (session.provider !== "local") return created;
  const installation = await loadInstallationConfig();
  await resourceLocationIndexForInstallation(installation).register({
    kind: "advanced-artifact",
    resourceId: created.summary.id,
    projectId: thread.projectId,
    threadId: thread.id,
    messageId: message.id,
    storageOwnerId: session.user.id,
    relativePath: null,
    fileName: created.summary.title,
    mediaType: "application/vnd.aibrain.artifact+json",
    size: Buffer.byteLength(JSON.stringify(created.snapshot), "utf8"),
    sha256: created.snapshot.contentSha256,
  });
  return created;
}

export async function createAdvancedArtifactVersion(
  session: AuthSession,
  artifactId: string,
  input: CreateAdvancedArtifactVersionInput,
) {
  if (session.provider !== "local") {
    const store = await advancedArtifactStoreForSession(session);
    const current = await store.get(session.user.id, artifactId);
    const { thread, message } = await sourceMessage(session, input.threadId, input.messageId);
    return store.createVersion(session.user.id, artifactId, {
      source: source(thread, message),
      content: content(current.summary.kind, message, input, current.summary.title),
    });
  }
  const resource = await resolveAdvancedArtifactResource(session, artifactId);
  assertLibraryResourceWritable(resource.access);
  const store = await advancedArtifactStoreForSession(session);
  const current = await store.get(resource.location.storageOwnerId, artifactId);
  const { thread, message } = await sourceMessage(session, input.threadId, input.messageId);
  if (thread.projectId !== resource.location.projectId) {
    throw new AdvancedArtifactValidationError("La nueva versión debe pertenecer al mismo proyecto compartido.");
  }
  const created = await store.createVersion(resource.location.storageOwnerId, artifactId, {
    source: source(thread, message),
    content: content(current.summary.kind, message, input, current.summary.title),
  });
  await resource.index.updateIntegrity("advanced-artifact", artifactId, {
    size: Buffer.byteLength(JSON.stringify(created.snapshot), "utf8"),
    sha256: created.snapshot.contentSha256,
  });
  return created;
}

export async function getAdvancedArtifactForSession(
  session: AuthSession,
  artifactId: string,
  requestedVersion?: number,
) {
  if (session.provider !== "local") {
    return (await advancedArtifactStoreForSession(session)).get(session.user.id, artifactId, requestedVersion);
  }
  const resource = await resolveAdvancedArtifactResource(session, artifactId);
  const store = await advancedArtifactStoreForSession(session);
  const artifact = await store.get(resource.location.storageOwnerId, artifactId, requestedVersion);
  if (artifact.summary.projectId !== resource.location.projectId ||
      artifact.summary.id !== resource.location.resourceId) {
    throw new AdvancedArtifactValidationError("El artefacto no coincide con su ubicación indexada.");
  }
  if (requestedVersion === undefined && (artifact.snapshot.contentSha256 !== resource.location.sha256 ||
      Buffer.byteLength(JSON.stringify(artifact.snapshot), "utf8") !== resource.location.size)) {
    throw new AdvancedArtifactValidationError("El artefacto no coincide con su integridad indexada.");
  }
  return artifact;
}

export async function listAdvancedArtifactsForSession(session: AuthSession) {
  if (session.provider !== "local") {
    return (await advancedArtifactStoreForSession(session)).list(session.user.id);
  }
  const installation = await loadInstallationConfig();
  const snapshot = await loadWorkbench(session);
  const visibleProjectIds = new Set(snapshot.projects.map((project) => project.id));
  const index = resourceLocationIndexForInstallation(installation);
  const locations = await index.listForProjects(visibleProjectIds, "advanced-artifact");
  const store = await advancedArtifactStoreForSession(session);
  const artifacts = await Promise.all(locations.map(async (location) => {
    try {
      const value = await store.get(location.storageOwnerId, location.resourceId);
      if (value.summary.projectId !== location.projectId || value.snapshot.contentSha256 !== location.sha256 ||
          Buffer.byteLength(JSON.stringify(value.snapshot), "utf8") !== location.size) return null;
      return value.summary;
    } catch {
      return null;
    }
  }));
  return artifacts.filter((artifact): artifact is NonNullable<typeof artifact> => artifact !== null)
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function publishAdvancedArtifactForSession(session: AuthSession, artifactId: string) {
  if (session.provider !== "local") {
    return (await advancedArtifactStoreForSession(session)).publish(session.user.id, artifactId, renderArtifactHtml);
  }
  const resource = await resolveAdvancedArtifactResource(session, artifactId);
  assertLibraryResourceWritable(resource.access);
  const store = await advancedArtifactStoreForSession(session);
  return store.publish(resource.location.storageOwnerId, artifactId, renderArtifactHtml);
}

export async function readPublishedAdvancedArtifactForSession(
  session: AuthSession,
  artifactId: string,
  version: number,
) {
  if (session.provider !== "local") {
    return (await advancedArtifactStoreForSession(session)).readPublished(session.user.id, artifactId, version);
  }
  const resource = await resolveAdvancedArtifactResource(session, artifactId);
  const store = await advancedArtifactStoreForSession(session);
  return store.readPublished(resource.location.storageOwnerId, artifactId, version);
}
