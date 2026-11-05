import { deploymentIdentity } from "@/deployment/identities";
import "server-only";
import { automationWorkspaceForSession, validateAutomationAudience } from "@/automations/server-service";
import type { AuthSession } from "@/auth/types";
import type { AutomationAudience } from "@/automations/contracts";
import { getWritableProject } from "@/workbench/store";
import { HostAnalysisStore } from "./store";
import { HOST_ANALYSIS_JOBS, isHostJob, JOB_LABELS, type HostAnalysisJob } from "./contracts";

async function workspace(session: AuthSession) {
  const w = await automationWorkspaceForSession(session);
  // Same genuinely authenticated employee as the existing Trinalum adapter.
  // Never accept an actor, tenant or email in the registration body.
  if (w.installation.installationId !== "trinalum-production" || (w.principal.email !== deploymentIdentity("operator") || w.principal.userId !== deploymentIdentity("hostOwnerId"))) throw Error("HOST_BINDING_OWNER_REQUIRED");
  return { ...w, store: new HostAnalysisStore(w.installation) };
}
export async function hostBindingsForSession(session: AuthSession) {
  const w = await workspace(session);
  return Promise.all(HOST_ANALYSIS_JOBS.map(async job => ({ job, label: JOB_LABELS[job], binding: await w.store.binding(job) })));
}
export async function authorizeHostJob(session: AuthSession, input: { job: HostAnalysisJob; projectId: string; audience: AutomationAudience }) {
  if (!isHostJob(input.job)) throw Error("UNAUTHORIZED_AUTOMATION_JOB");
  const w = await workspace(session); await getWritableProject(session, input.projectId);
  const audience = validateAutomationAudience(input.audience, w, w.principal.userId);
  return w.store.authorize({ job: input.job, installationId: w.installation.installationId,
    userId: w.principal.userId, email: w.principal.email, projectId: input.projectId, audience }, async b => {
    await w.store.tasks(b.userId).create({ name: JOB_LABELS[b.job], prompt: `Análisis host autorizado: ${b.job}. Solo lotes del adaptador nativo.`,
      projectId: b.projectId, projectName: (await getWritableProject(session, b.projectId)).name,
      timeZone: "Europe/Madrid", schedule: { kind: "external" }, audience }, { id: b.taskId });
  });
}
export async function revokeHostJob(session: AuthSession, job: HostAnalysisJob) {
  const w = await workspace(session); await w.store.revoke(job, w.principal.userId);
}
