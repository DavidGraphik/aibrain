import "server-only";

import { loadInstallationConfig } from "@/config/installation";
import { stopWorkerRuntimeForUser } from "@/runtime/worker-runtime-service";
import {
  UserLifecycleService,
  type UserLifecycleCommand,
} from "@/users/lifecycle";

export async function executeUserLifecycleCommand(command: UserLifecycleCommand) {
  const installation = await loadInstallationConfig();
  return new UserLifecycleService(installation, {
    stopWorker: stopWorkerRuntimeForUser,
  }).execute(command);
}
