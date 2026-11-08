import { hostWorkTimer } from "./budget";
import type { ScheduledExecutionInput } from "@/automations/executor";
import type { ResolvedPermissions } from "@/permissions";
import { documentServicesForUser } from "@/documents/server-service";
import { validateUploadedDocument } from "@/documents/upload-validation";
import { resolveTurnDocumentAttachments, ServerTurnDocumentInputResolver } from "@/documents/turn-attachments";
import { resourceLocationIndexForInstallation } from "@/library/server-resource-access";
import { automationWorkspaceContext, validateAutomationAudience } from "@/automations/server-service";
import { getWritableProject } from "@/workbench/store";
import { HostAnalysisStore } from "./store";
import { currentHostPermissions } from "./permissions";
import { featurePolicyForIdentity } from "@/settings/server-service";
import { prepareHostAnalysis } from "./input";
import { stableId, UUID } from "./contracts";

/** Internal worker adapter. Authority comes from the UI-signed binding, never the host envelope. */
export async function hostExecution(input: ScheduledExecutionInput) {
  const store = new HostAnalysisStore(input.installation);
  const binding = await store.forTask(input.task.id);
  const prefix = `${input.task.id}:manual:`;
  const requestId = input.runKey.startsWith(prefix) ? input.runKey.slice(prefix.length) : "";
  if (!binding || !UUID.test(requestId) || binding.userId !== input.session.user.id) throw Error("HOST_BINDING_REQUIRED");
  const submission = await store.admit(binding, requestId);
  const prepared = prepareHostAnalysis(submission.envelope);
  let permissionFingerprint: string | null = null;
  const assertScope = async () => {
    await store.request(binding, requestId);
    await getWritableProject(input.session, binding.projectId);
    if (prepared.businessReads && !(await featurePolicyForIdentity(input.installation.installationId, binding.userId))["web-search"]) throw Error("HOST_WEB_PERMISSION_REVOKED");
    validateAutomationAudience(binding.audience, await automationWorkspaceContext(input.installation), binding.userId);
  };
  await assertScope();
  const workTimer = hostWorkTimer(submission.budget);
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, workTimer.signal, ...(input.signal ? [input.signal] : [])]);
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return; checking = true;
    void assertScope().catch(error => controller.abort(error)).finally(() => { checking = false; });
  }, 2_000);
  timer.unref?.();
  return {
    message: prepared.message, signal, terminalDeadlineAt: submission.budget.terminalUntil,
    policy: { businessReads: prepared.businessReads, webSearch: prepared.businessReads, onViolation: () => controller.abort(Error("HOST_ANALYSIS_READ_ONLY")) },
    dispose: () => { clearInterval(timer); workTimer.dispose(); },
    finalize: (persist: () => Promise<void>) => store.finalize(binding, requestId, persist),
    async documents(threadId: string, permissions: ResolvedPermissions) {
      permissionFingerprint = permissions.fingerprint;
      if (!prepared.documents.length) return [];
      const services = await documentServicesForUser(input.installation, binding.userId);
      const uploadIds: string[] = [];
      for (const file of prepared.documents) {
        signal.throwIfAborted(); await assertScope();
        const uploadId = stableId(`${input.runKey}:upload:${file.fileName}`);
        const validated = validateUploadedDocument({ fileName: file.fileName, declaredMimeType: file.mime, data: file.bytes });
        const document = await services.storageGate.run(() => services.staging.stage({ threadId, uploadId, validated, data: file.bytes }), { signal });
        await services.previews.create(document, { signal });
        await services.versions.create({ threadId, documentId: uploadId, document,
          author: { userId: binding.userId, name: input.session.user.name }, scope: { kind: "project", id: binding.projectId } });
        await resourceLocationIndexForInstallation(input.installation).register({ kind: "upload", resourceId: uploadId,
          projectId: binding.projectId, threadId, messageId: null, storageOwnerId: binding.userId,
          relativePath: document.relativePath, fileName: document.fileName, mediaType: document.mediaType, size: document.size, sha256: document.sha256 });
        uploadIds.push(uploadId);
      }
      return resolveTurnDocumentAttachments({ staging: services.staging, threadId, uploadIds, permissions, signal,
        inputResolver: new ServerTurnDocumentInputResolver({ stagingRoot: services.manifest.roots.staging,
          previews: services.previews, pdftotext: services.toolchain.pdftotext, conversionGate: services.conversionGate, workspaceXlsx: true }) });
    },
    async validate(text: string, threadId: string, alreadyRestored = false) {
      signal.throwIfAborted(); await assertScope();
      const current = await currentHostPermissions(input.installation, binding, input.runKey);
      if (current.fingerprint !== permissionFingerprint) throw Error("HOST_PERMISSIONS_CHANGED");
      const restored = prepared.validate(text, alreadyRestored); // exact existing coverage validator, before terminal persistence
      await store.saveResult(binding, requestId, threadId, restored, current.fingerprint);
      return restored;
    },
  };
}
