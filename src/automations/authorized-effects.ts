import 'server-only';
import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { DynamicToolCallResponse } from '../../contracts/codex/0.162.1/types/v2/DynamicToolCallResponse';
import type { AuthSession } from '@/auth/types';
import { readRegularFileWithin } from '@/security/safe-file';
import { FileLocalUserStore } from '@/auth/local-user-store';
import type { InstallationConfig } from '@/config/installation-schema';
import type { ResolvedPermissions } from '@/permissions';
import { permissionAllowsGenericToolExecution, resolveServerTurnPermissions } from '@/runtime/permission-turn';
import { getWritableProject } from '@/workbench/store';
import { atomicWriteJson, ResourceLockManager, type StorageSchema } from '@/storage';
import { isAutomationExecutionContext, type AutomationAllowedEffect, type AutomationTask } from './contracts';
import { automationEffectHash } from './effect-grant';
import { FileAutomationStore } from './store';
import { automationOccurrenceStillEligible } from './run-eligibility';

export type AutomationEffectAuthorization = Readonly<{
  installationId: string; userId: string; projectId: string;
  allowedEffects: readonly AutomationAllowedEffect[]; taskId: string; runKey: string; signal: AbortSignal;
  revalidate: () => Promise<boolean>;
  runEffect: (operation: string, input: Record<string, unknown>, dispatch: () => Promise<DynamicToolCallResponse>) => Promise<DynamicToolCallResponse>;
}>;
const issued = new WeakSet<object>();

export function effectForAutomationOperation(operation: string, input: Record<string, unknown>): AutomationAllowedEffect | null {
  if (operation === 'attio_action' && input.type === 'create_task') return 'attio-task';
  if (operation === 'attio_action' && input.type === 'create_note') return 'attio-note';
  if (['mail_action', 'mail_draft'].includes(operation) && input.type === 'create_draft') return 'mail-draft';
  return null;
}

export async function assertAutomationEffectAuthorization(value: AutomationEffectAuthorization | undefined, identity: { installationId: string; userId: string; projectId?: string }) {
  if (!value || !issued.has(value) || value.signal.aborted || value.installationId !== identity.installationId || value.userId !== identity.userId ||
    identity.projectId !== undefined && value.projectId !== identity.projectId || !await value.revalidate()) throw Error('AUTOMATION_EFFECT_AUTHORIZATION_DENIED');
  return value;
}

function canonical(value: unknown): unknown {
  if (value === null || ['string','boolean'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)]));
  throw Error('AUTOMATION_EFFECT_INPUT_INVALID');
}

function completedReadback(response: DynamicToolCallResponse) {
  if (!response.success) return false;
  for (const item of response.contentItems) {
    if (item.type !== 'inputText') continue;
    let value: unknown; try { value = JSON.parse(item.text); } catch { continue; }
    if (!value || typeof value !== 'object' || !('outcome' in value) || !['executed','replayed'].includes(String(value.outcome))) continue;
    const hasReceipt = (data: unknown, depth = 0): boolean => {
      if (!data || typeof data !== 'object' || depth > 5) return false;
      if ('status' in data && data.status === 'completed' && 'readback' in data && data.readback !== null && typeof data.readback === 'object' && Object.keys(data.readback).length > 0) return true;
      return 'data' in data && hasReceipt(data.data,depth+1);
    };
    if (hasReceipt(value)) return true;
  }
  return false;
}

type Receipt = { schemaVersion: 1; taskId: string; operation: string; inputHash: string; state: 'uncertain' | 'completed'; response?: DynamicToolCallResponse };
const receiptSchema: StorageSchema<Receipt> = { name:'AutomationEffectReceipt', parse(value) {
  const record = value as Receipt;
  if (!record || record.schemaVersion !== 1 || !['uncertain','completed'].includes(record.state) || !/^[a-f0-9]{64}$/u.test(record.inputHash) ||
    typeof record.taskId !== 'string' || typeof record.operation !== 'string' || record.state === 'completed' && (!record.response || !completedReadback(record.response))) throw Error('AUTOMATION_EFFECT_RECEIPT_INVALID');
  return record;
}};

/** A process-local capability from the claimed, persisted task. Tool/model JSON
 * cannot manufacture it. No grant is inferred from a prompt or retrieved email. */
export async function createAutomationEffectAuthorization(input: {
  installation: Readonly<InstallationConfig>; session: AuthSession; task: AutomationTask; runKey: string;
  localTurnId: string; permissions: ResolvedPermissions; signal: AbortSignal;
}): Promise<AutomationEffectAuthorization | undefined> {
  const context = input.task.executionContext, grant = context.effectGrant;
  if (!context.allowedEffects?.length) return undefined;
  if (!isAutomationExecutionContext(context) || !grant || input.installation.installationId !== 'trinalum-production' ||
    input.session.tenant.id !== input.installation.installationId || input.task.installationId !== input.installation.installationId ||
    input.task.userId !== input.session.user.id || input.task.schedule.kind === 'external' ||
    grant.installationId !== input.task.installationId || grant.userId !== input.task.userId || grant.projectId !== input.task.projectId ||
    grant.requestHash !== automationEffectHash(grant.sourceMessage) || grant.actionPromptHash !== automationEffectHash(input.task.prompt) ||
    !input.task.lease?.fenceToken || input.task.lease.runKey !== input.runKey || input.signal.aborted ||
    input.permissions.installationId !== input.installation.installationId || input.permissions.userId !== input.session.user.id ||
    input.permissions.turnId !== input.localTurnId || !permissionAllowsGenericToolExecution(input.permissions)) throw Error('AUTOMATION_EFFECT_AUTHORIZATION_DENIED');
  const store = new FileAutomationStore({ installationId: input.installation.installationId, userId: input.session.user.id, usersRoot: input.installation.paths.usersRoot });
  const revalidate = async () => {
    try {
      if (input.signal.aborted) return false;
      const fresh = await store.get(input.task.id), user = await new FileLocalUserStore(input.installation.paths.usersRoot).read(input.session.user.id);
      if (!user?.enabled || user.email !== input.session.user.email.toLowerCase() || !automationOccurrenceStillEligible(fresh,input.task,input.runKey) ||
        fresh.projectId !== input.task.projectId || fresh.prompt !== input.task.prompt || JSON.stringify(fresh.executionContext) !== JSON.stringify(context) ||
        !fresh.lease || fresh.lease.runKey !== input.runKey || fresh.lease.fenceToken !== input.task.lease!.fenceToken ||
        fresh.lease.ownerId !== input.task.lease!.ownerId || Date.parse(fresh.lease.expiresAt) <= Date.now()) return false;
      await getWritableProject(input.session, fresh.projectId);
      const permissions = await resolveServerTurnPermissions(input.installation, { installationId: input.installation.installationId, userId: input.session.user.id, projectId: fresh.projectId, turnId: input.localTurnId });
      return permissionAllowsGenericToolExecution(permissions);
    } catch { return false; }
  };
  const root = path.join(input.installation.paths.usersRoot,input.session.user.id,'automations','effect-receipts');
  await mkdir(root,{recursive:true,mode:0o700});
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) throw Error('AUTOMATION_EFFECT_STORAGE_INVALID');
  const locks = new ResourceLockManager({rootDirectory:path.join(root,'locks')});
  const authority: AutomationEffectAuthorization = Object.freeze({
    installationId: input.installation.installationId, userId: input.session.user.id, projectId: input.task.projectId,
    allowedEffects: Object.freeze([...context.allowedEffects]), taskId: input.task.id, runKey: input.runKey, signal: input.signal, revalidate,
    async runEffect(operation: string, effectInput: Record<string, unknown>, dispatch: () => Promise<DynamicToolCallResponse>) {
      await assertAutomationEffectAuthorization(authority, {installationId:input.session.tenant.id,userId:input.session.user.id,projectId:input.task.projectId});
      const effect = effectForAutomationOperation(operation,effectInput);
      if (!effect || !authority.allowedEffects.includes(effect)) throw Error('AUTOMATION_EFFECT_NOT_ALLOWED');
      const serialized = JSON.stringify(canonical(effectInput));
      if (Buffer.byteLength(serialized)>2*1024*1024) throw Error('AUTOMATION_EFFECT_INPUT_TOO_LARGE');
      // Typed and generic draft tools refer to the same effect. Changing the
      // tool alias must not create a second draft for an identical payload.
      const inputHash = automationEffectHash(serialized), key = automationEffectHash(JSON.stringify([input.task.id,effect,inputHash]));
      return locks.withLock(key,async()=>{
        await assertAutomationEffectAuthorization(authority,{installationId:input.task.installationId,userId:input.task.userId,projectId:input.task.projectId});
        await mkdir(root,{recursive:true,mode:0o700});
        const file = path.join(root,`${key}.json`);
        let previous: Receipt | undefined;
        try { previous = receiptSchema.parse(JSON.parse((await readRegularFileWithin(root,`${key}.json`,2*1024*1024)).toString('utf8'))); } catch(error) { if (!(error && typeof error==='object' && 'code' in error && error.code==='ENOENT')) throw error; }
        if (previous) {
          if (previous.taskId !== input.task.id || previous.operation !== effect || previous.inputHash !== inputHash) throw Error('AUTOMATION_EFFECT_RECEIPT_CONFLICT');
          if (previous.state === 'completed') return previous.response!;
          throw Error('AUTOMATION_EFFECT_OUTCOME_UNCERTAIN');
        }
        const receipt: Receipt = {schemaVersion:1,taskId:input.task.id,operation:effect,inputHash,state:'uncertain'};
        await atomicWriteJson(file,receipt,receiptSchema);
        const response = await dispatch();
        if (!completedReadback(response)) throw Error('AUTOMATION_EFFECT_READBACK_REQUIRED');
        if (Buffer.byteLength(JSON.stringify(response))>2*1024*1024) throw Error('AUTOMATION_EFFECT_RECEIPT_TOO_LARGE');
        await atomicWriteJson(file,{...receipt,state:'completed',response},receiptSchema);
        return response;
      });
    },
  });
  issued.add(authority);
  await assertAutomationEffectAuthorization(authority,{installationId:input.task.installationId,userId:input.task.userId,projectId:input.task.projectId});
  return authority;
}
