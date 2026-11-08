import "server-only";
import { quietAutomationResultMessageIds } from "@/automations/thread-access";

import type { AuthSession } from "@/auth/types";
import { loadInstallationConfig } from "@/config/installation";
import {
  DEFAULT_TASK_NOTIFICATION_PREFERENCES,
  deriveTaskCenterItems,
  taskCenterId,
  type TaskCenterPayload,
  type TaskNotificationPreferences,
} from "@/task-center/contracts";
import { FileTaskCenterStore } from "@/task-center/file-store";
import { queueTaskCenterRead } from "@/task-center/read-queue";
import { WorkbenchNotFoundError, WorkbenchPersistenceError } from "@/workbench/errors";
import { createWorkbenchThreadReader, loadWorkbench } from "@/workbench/store";

async function localStore(session: AuthSession) {
  const installation = await loadInstallationConfig();
  if (session.provider !== "local" || session.tenant.id !== installation.installationId) {
    throw new WorkbenchPersistenceError("La sesión no pertenece a esta instalación.");
  }
  return FileTaskCenterStore.fromInstallation(installation);
}

async function visibleTasks(session:AuthSession,workbench:Parameters<typeof deriveTaskCenterItems>[0],readIds:readonly string[]){
  const quiet=new Set((await quietAutomationResultMessageIds(session)).map(item=>taskCenterId(item.threadId,item.messageId)));
  const archivedProjects=new Set(workbench.projects.filter(project=>project.status==="archived").map(project=>project.id));
  const tasks:TaskCenterPayload["tasks"]=[];
  // The authorized metadata directory is small. Hydrate one authorized thread
  // at a time, immediately reduce it to task DTOs, and release its history.
  // The request reader rechecks current access without rescanning siblings.
  const readThread = await createWorkbenchThreadReader(session);
  for(const metadata of workbench.threads){
    if(metadata.status==="archived"||archivedProjects.has(metadata.projectId))continue;
    let thread;
    try { thread=await readThread(metadata.id); }
    catch(error){ if(error instanceof WorkbenchNotFoundError)continue; throw error; }
    if(thread.status==="archived")continue;
    for(const item of deriveTaskCenterItems({projects:workbench.projects,threads:[thread]},readIds)){
      // Force small text copies: a V8 substring title must not retain the
      // backing buffer of a large original message after this iteration.
      if(!quiet.has(item.id))tasks.push({...item,title:Buffer.from(item.title,"utf8").toString("utf8"),detail:Buffer.from(item.detail,"utf8").toString("utf8")});
    }
  }
  return tasks.sort((left,right)=>right.updatedAt.localeCompare(left.updatedAt)||right.id.localeCompare(left.id));
}

export async function getTaskCenter(session: AuthSession): Promise<TaskCenterPayload> {
  return queueTaskCenterRead(() => readTaskCenter(session));
}

async function readTaskCenter(session: AuthSession): Promise<TaskCenterPayload> {
  const workbench = await loadWorkbench(session, true);
  const state = session.provider === "local"
    ? await (await localStore(session)).load(session.user.id)
    : { readTaskIds: [], preferences: DEFAULT_TASK_NOTIFICATION_PREFERENCES };
  return {
    tasks: await visibleTasks(session,workbench,state.readTaskIds),
    readTaskIds: state.readTaskIds,
    preferences: state.preferences,
    continuity: "worker_required",
  };
}

export async function updateTaskCenter(
  session: AuthSession,
  update: { markRead?: string[]; preferences?: TaskNotificationPreferences },
): Promise<TaskCenterPayload> {
  return queueTaskCenterRead(() => writeTaskCenter(session, update));
}

async function writeTaskCenter(
  session: AuthSession,
  update: { markRead?: string[]; preferences?: TaskNotificationPreferences },
): Promise<TaskCenterPayload> {
  const workbench = await loadWorkbench(session, true);
  const state = session.provider === "local"
    ? await (await localStore(session)).update(session.user.id, update)
    : {
        readTaskIds: update.markRead ?? [],
        preferences: update.preferences ?? DEFAULT_TASK_NOTIFICATION_PREFERENCES,
      };
  return {
    tasks: await visibleTasks(session,workbench,state.readTaskIds),
    readTaskIds: state.readTaskIds,
    preferences: state.preferences,
    continuity: "worker_required",
  };
}
