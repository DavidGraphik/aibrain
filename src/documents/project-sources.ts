import path from "node:path";
import type { InstallationConfig } from "@/config/installation-schema";
import type { ProjectSource } from "@/workbench/types";
import { isUuid } from "@/workbench/types";
import { FileDocumentStagingStore } from "./staging-store";
import { ResourceLockManager } from "@/storage/resource-lock";
import type { ResolvedPermissions } from "@/permissions";
import type { ResolvedTurnDocument } from "./turn-attachments";

/** Server-private immutable originals; project/owner IDs must come from authorized workbench access. */
export function projectSourceStore(config: Readonly<InstallationConfig>, ownerUserId: string) {
  if (!isUuid(ownerUserId)) throw new Error("Invalid project source owner.");
  const root = path.join(config.paths.dataRoot, "server", "project-sources", ownerUserId);
  const locks = new ResourceLockManager({ rootDirectory: path.join(root, ".locks") });
  return { staging: new FileDocumentStagingStore(root, locks), locks };
}

export type RuntimeProjectSource = Pick<ProjectSource, "kind" | "name" | "url" | "excerpt" | "status"> & { id?: string };

export async function resolveProjectSourceDocuments(input: {
  config: Readonly<InstallationConfig>; ownerUserId?: string; projectId: string;
  sources: readonly RuntimeProjectSource[]; permissions: ResolvedPermissions;
}) {
  const sources = input.sources.filter(source => source.kind === "file" && source.status === "ready" && !source.excerpt);
  if (!sources.length) return { documents: [] as ResolvedTurnDocument[], root: "" };
  const rules = input.permissions.rules.filter(rule => rule.ruleId === "documents.read" && rule.action === "consult");
  if (!rules.some(rule => rule.effect === "allow") || rules.some(rule => rule.effect === "deny")) {
    throw new Error("No tienes permiso para leer los documentos de referencia del proyecto.");
  }
  if (!input.ownerUserId || !isUuid(input.projectId)) throw new Error("No se ha podido verificar el propietario de las referencias.");
  const { staging } = projectSourceStore(input.config, input.ownerUserId);
  const documents: ResolvedTurnDocument[] = [];
  let total = 0;
  for (const source of sources) {
    if (!source.id) throw new Error("La referencia necesita volver a adjuntarse.");
    const document = await staging.readById(input.projectId, source.id);
    if (document.fileName !== source.name || !["xlsx", "pdf", "docx", "pptx", "text"].includes(document.kind)) {
      throw new Error("El archivo de referencia no coincide con el documento guardado.");
    }
    total += document.size;
    if (total > 200 * 1024 * 1024) throw new Error("Las referencias del proyecto superan 200 MB. Divide los documentos entre proyectos.");
    documents.push({ document, absolutePath: path.join(staging.rootDirectory, document.relativePath), codexInputs: [] });
  }
  return { documents, root: staging.rootDirectory };
}
