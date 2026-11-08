import "server-only";

import { trinalumAudioBroker } from "@/documents/trinalum-audio-broker";
import path from "node:path";
import type { InstallationConfig } from "@/config/installation-schema";
import { FileDocumentConversionGate } from "@/documents/conversion-gate";
import { FileDocumentPublisher } from "@/documents/document-publisher";
import { FilePublicationCapacityGate } from "@/documents/publication-capacity";
import { DocumentPreviewService, type DocumentToolchain } from "@/documents/preview-service";
import { FileDocumentStagingStore } from "@/documents/staging-store";
import { FileDocumentStorageGate } from "@/documents/storage-gate";
import { FileDocumentVersionStore } from "@/documents/version-store";
import { WorkerProvisioner } from "@/runtime/workers/provisioner";
import { ResourceLockManager } from "@/storage";
import { StorageError } from "@/storage/errors";
import type { ResolvedPermissions } from "@/permissions";
import { EnterpriseDocumentNetwork } from "@/documents/enterprise-document-network";
import { G03PublicationClient } from "@/g03/publication-client";
import { G03RemoteDocumentPublisher } from "@/g03/remote-document-publisher";

function configuredAbsolutePath(name: string, fallback: string) {
  const value = process.env[name]?.trim() || fallback;
  if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute executable path.`);
  return path.resolve(value);
}

export type ConfiguredDocumentToolchain = DocumentToolchain & { pdftotext: string };

export function documentToolchainFromEnvironment(): ConfiguredDocumentToolchain {
  const darwin = process.platform === "darwin";
  const qpdf = process.env.AIBRAIN_QPDF_BIN?.trim() ||
    (process.env.NODE_ENV === "production" ? "/usr/local/bin/aibrain-qpdf" : undefined);
  const ffprobe = process.env.AIBRAIN_FFPROBE_BIN?.trim();
  const audioTranscriber = process.env.AIBRAIN_AUDIO_TRANSCRIBER_BIN?.trim();
  return {
    ...(ffprobe ? { ffprobe: configuredAbsolutePath("AIBRAIN_FFPROBE_BIN", ffprobe) } : {}),
    ...(audioTranscriber ? { audioTranscriber: configuredAbsolutePath("AIBRAIN_AUDIO_TRANSCRIBER_BIN", audioTranscriber) } : {}),
    soffice: configuredAbsolutePath(
      "AIBRAIN_SOFFICE_BIN",
      darwin ? "/Applications/LibreOffice.app/Contents/MacOS/soffice" : "/usr/local/bin/aibrain-soffice",
    ),
    pdfinfo: configuredAbsolutePath(
      "AIBRAIN_PDFINFO_BIN",
      darwin ? "/opt/homebrew/bin/pdfinfo" : "/usr/local/bin/aibrain-pdfinfo",
    ),
    pdftoppm: configuredAbsolutePath(
      "AIBRAIN_PDFTOPPM_BIN",
      darwin ? "/opt/homebrew/bin/pdftoppm" : "/usr/local/bin/aibrain-pdftoppm",
    ),
    pdftotext: configuredAbsolutePath(
      "AIBRAIN_PDFTOTEXT_BIN",
      darwin ? "/opt/homebrew/bin/pdftotext" : "/usr/local/bin/aibrain-pdftotext",
    ),
    ...(qpdf ? { qpdf: configuredAbsolutePath("AIBRAIN_QPDF_BIN", qpdf) } : {}),
  };
}

export async function documentServicesForUser(
  installation: Readonly<InstallationConfig>,
  userId: string,
) {
  const manifest = await new WorkerProvisioner({ config: installation }).provision(userId);
  const stateRoot = path.join(manifest.roots.userRoot, "state");
  const locks = new ResourceLockManager({
    rootDirectory: path.join(stateRoot, ".locks", "documents"),
  });
  const staging = new FileDocumentStagingStore(manifest.roots.staging, locks);
  // Outside every worker-visible root and absent from the library/download index.
  const legacyOriginals = new FileDocumentStagingStore(
    path.join(installation.paths.dataRoot, "server", "legacy-excel-originals", userId), locks,
  );
  const passiveXlsReader = configuredAbsolutePath("AIBRAIN_XLS_PASSIVE_BIN", "/usr/local/bin/aibrain-xls-passive");
  const conversionGate = new FileDocumentConversionGate({
    rootDirectory: path.join(installation.paths.dataRoot, "locks", "document-conversions"),
  });
  const storageGate = new FileDocumentStorageGate({
    rootDirectory: path.join(installation.paths.dataRoot, "locks", "document-storage"),
    capacityDirectories: [manifest.roots.staging, path.join(stateRoot, "document-previews"),
      path.join(stateRoot, "document-history"), legacyOriginals.rootDirectory],
  });
  const toolchain = documentToolchainFromEnvironment();
  const previews = new DocumentPreviewService({
    stagingRoot: manifest.roots.staging,
    previewRoot: path.join(stateRoot, "document-previews"),
    lockManager: locks,
    tools: toolchain,
    conversionGate,
    ...(process.env.AIBRAIN_TRINALUM_AUDIO_BROKER_ENABLED === "1" && installation.installationId === "trinalum-production"
      ? { audioTranscribe: (document, source, signal) => trinalumAudioBroker(installation.installationId, userId, document, source, signal) } : {}),
    audioGate: new FileDocumentConversionGate({
      rootDirectory: path.join(installation.paths.dataRoot, "locks", "audio-transcriptions"),
      maxConcurrent: 1,
    }),
  });
  const versions = new FileDocumentVersionStore(
    path.join(stateRoot, "document-history"),
    locks,
  );
  return { manifest, locks, staging, legacyOriginals, passiveXlsReader, previews, versions, toolchain, conversionGate, storageGate };
}

function publicationSecret() {
  const secret = process.env.AIBRAIN_PUBLICATION_SECRET;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("AIBRAIN_PUBLICATION_SECRET must contain at least 32 bytes.");
  }
  return secret;
}

export async function documentPublisherForUser(
  installation: Readonly<InstallationConfig>,
  userId: string,
  context?: { projectId: string; permissions?: ResolvedPermissions },
) {
  const remoteG03 = installation.installationId === "g03-production" || installation.installationId === "g03-qa";
  if (remoteG03 && (process.env.AIBRAIN_G03_PUBLICATION_ENABLED !== "true" || !context)) {
    throw new StorageError("PUBLICATION_REMOTE_DISABLED", "Windows publication has not passed its activation gate.");
  }
  const services = await documentServicesForUser(installation, userId);
  if (remoteG03 && context) {
    let authorized = false;
    if (context.permissions) {
      const network = new EnterpriseDocumentNetwork(installation);
      const roots = await network.rootsForTurn({ userId, projectId: context.projectId, permissions: context.permissions });
      authorized = roots.some((root) => root.scope === "company" && root.scopeId === null);
    }
    const client = new G03PublicationClient({ installationId: installation.installationId,
      socketDirectory: path.join(installation.paths.dataRoot, "locks", "server-files") });
    const requireAccess = () => { if (!authorized) throw new StorageError("PUBLICATION_SCOPE_MISMATCH", "Company documents are not authorized for this turn."); };
    return new G03RemoteDocumentPublisher({ installationId: installation.installationId, userId, projectId: context.projectId,
      stagingRoot: services.manifest.roots.staging,
      stateRoot: path.join(installation.paths.dataRoot, "remote-publications", "g03"),
      workerVisibleRoots: [services.manifest.roots.runtimeRoot, services.manifest.roots.workspace,
        services.manifest.roots.staging, services.manifest.roots.artifacts, services.manifest.roots.browserRoot,
        installation.paths.companyContextRoot, installation.paths.sourceReadRoot],
      confirmationSecret: publicationSecret(),
      locks: new ResourceLockManager({ rootDirectory: path.join(installation.paths.dataRoot, "locks", "g03-publications") }),
      transport: {
        snapshot: (target) => { requireAccess(); return client.snapshot(target); },
        publish: (binding, data) => { requireAccess(); return client.publish(binding, data); },
        receipt: (binding) => { requireAccess(); return client.receipt(binding); },
      },
    });
  }
  const stateRoot = path.join(services.manifest.roots.userRoot, "state", "publications");
  return new FileDocumentPublisher({
    installationId: installation.installationId,
    userId,
    stagingRoot: services.manifest.roots.staging,
    publishWriteRoot: installation.paths.publishWriteRoot,
    stateRoot,
    workerVisibleRoots: [
      services.manifest.roots.runtimeRoot,
      services.manifest.roots.workspace,
      services.manifest.roots.staging,
      services.manifest.roots.artifacts,
      services.manifest.roots.browserRoot,
      installation.paths.companyContextRoot,
      installation.paths.sourceReadRoot,
    ],
    lockManager: services.locks,
    targetLockManager: new ResourceLockManager({
      rootDirectory: path.join(
        installation.paths.dataRoot,
        "locks",
        "document-publication-targets",
      ),
    }),
    confirmationSecret: publicationSecret(),
    capacityGate: new FilePublicationCapacityGate({
      rootDirectory: path.join(
        installation.paths.dataRoot,
        "locks",
        "document-publication-capacity",
      ),
      capacityRoot: installation.paths.publishWriteRoot,
    }),
  });
}
