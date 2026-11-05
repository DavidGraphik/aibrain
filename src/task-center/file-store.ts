import "server-only";

import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { InstallationConfig } from "@/config/installation-schema";
import {
  atomicWriteJson,
  defineVersionedSchema,
  expectArray,
  expectBoolean,
  expectIsoDate,
  expectString,
  recoverAtomicJsonFile,
  ResourceLockManager,
} from "@/storage";
import {
  DEFAULT_TASK_NOTIFICATION_PREFERENCES,
  isTaskCenterId,
  type TaskCenterReadState,
  type TaskNotificationPreferences,
} from "@/task-center/contracts";
import { WorkbenchPersistenceError, WorkbenchValidationError } from "@/workbench/errors";

const SCHEMA_VERSION = 1 as const;
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INSTALLATION_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_READ_TASKS = 5_000;

type StoredTaskCenterState = TaskCenterReadState & {
  schemaVersion: typeof SCHEMA_VERSION;
  installationId: string;
  userId: string;
  updatedAt: string;
};

const taskCenterStateSchema = defineVersionedSchema<StoredTaskCenterState>({
  name: "TaskCenterState",
  schemaVersion: SCHEMA_VERSION,
  keys: ["installationId", "userId", "readTaskIds", "preferences", "updatedAt"],
  parse(record, context) {
    const preferences = record.preferences;
    if (!preferences || typeof preferences !== "object" || Array.isArray(preferences) ||
      Object.keys(preferences).length !== 2) {
      context.at("preferences").fail("expected notification preferences");
    }
    const preferenceRecord = preferences as Record<string, unknown>;
    const readTaskIds = expectArray(record.readTaskIds, context.at("readTaskIds"), (value, itemContext) => {
      const id = expectString(value, itemContext, { minLength: 73, maxLength: 73 });
      if (!isTaskCenterId(id)) itemContext.fail("expected a task center id");
      return id;
    }, { maxLength: MAX_READ_TASKS });
    if (new Set(readTaskIds).size !== readTaskIds.length) {
      context.at("readTaskIds").fail("task ids must be unique");
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      installationId: expectString(record.installationId, context.at("installationId"), {
        minLength: 2,
        maxLength: 63,
        pattern: INSTALLATION_ID_PATTERN,
      }),
      userId: expectString(record.userId, context.at("userId"), {
        minLength: 36,
        maxLength: 36,
        pattern: USER_ID_PATTERN,
      }),
      readTaskIds,
      preferences: {
        inApp: expectBoolean(preferenceRecord.inApp, context.at("preferences").at("inApp")),
        desktop: expectBoolean(preferenceRecord.desktop, context.at("preferences").at("desktop")),
      },
      updatedAt: expectIsoDate(record.updatedAt, context.at("updatedAt")),
    };
  },
});

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function initialState(installationId: string, userId: string): StoredTaskCenterState {
  return {
    schemaVersion: SCHEMA_VERSION,
    installationId,
    userId,
    readTaskIds: [],
    preferences: DEFAULT_TASK_NOTIFICATION_PREFERENCES,
    updatedAt: new Date(0).toISOString(),
  };
}

export class FileTaskCenterStore {
  readonly installationId: string;
  readonly usersRoot: string;

  constructor(options: { installationId: string; usersRoot: string }) {
    if (!INSTALLATION_ID_PATTERN.test(options.installationId)) {
      throw new WorkbenchPersistenceError("El identificador de instalación no es válido.");
    }
    if (!path.isAbsolute(options.usersRoot)) {
      throw new WorkbenchPersistenceError("La ruta de usuarios debe ser absoluta.");
    }
    this.installationId = options.installationId;
    this.usersRoot = path.resolve(options.usersRoot);
  }

  static fromInstallation(config: Readonly<InstallationConfig>) {
    return new FileTaskCenterStore({
      installationId: config.installationId,
      usersRoot: config.paths.usersRoot,
    });
  }

  private async paths(userId: string) {
    if (!USER_ID_PATTERN.test(userId)) throw new WorkbenchValidationError("El usuario no es válido.");
    const userRoot = path.resolve(this.usersRoot, userId);
    if (!inside(this.usersRoot, userRoot)) throw new WorkbenchPersistenceError("La ruta sale del usuario.");
    const stateRoot = path.join(userRoot, "state");
    const lockRoot = path.join(stateRoot, ".locks");
    for (const directory of [this.usersRoot, userRoot]) {
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new WorkbenchPersistenceError("El directorio de usuario no es seguro.");
      }
    }
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    await mkdir(lockRoot, { recursive: true, mode: 0o700 });
    for (const directory of [stateRoot, lockRoot]) {
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new WorkbenchPersistenceError("El directorio de estado de tareas no es seguro.");
      }
    }
    await chmod(stateRoot, 0o700);
    await chmod(lockRoot, 0o700);
    const [canonicalUsers, canonicalUser, canonicalState, canonicalLocks] = await Promise.all([
      realpath(this.usersRoot), realpath(userRoot), realpath(stateRoot), realpath(lockRoot),
    ]);
    if (!inside(canonicalUsers, canonicalUser) || !inside(canonicalUser, canonicalState) ||
      !inside(canonicalState, canonicalLocks)) {
      throw new WorkbenchPersistenceError("El estado de tareas sale del usuario autenticado.");
    }
    return {
      statePath: path.join(stateRoot, "task-center.json"),
      lockRoot,
    };
  }

  private async readUnlocked(userId: string, statePath: string) {
    let state: StoredTaskCenterState;
    try {
      const metadata = await lstat(statePath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
        throw new WorkbenchPersistenceError("El estado de tareas no es un fichero seguro.");
      }
      state = (await recoverAtomicJsonFile(statePath, taskCenterStateSchema)).value;
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      state = initialState(this.installationId, userId);
      await atomicWriteJson(statePath, state, taskCenterStateSchema);
    }
    if (state.installationId !== this.installationId || state.userId !== userId) {
      throw new WorkbenchPersistenceError("El estado de tareas pertenece a otro usuario o instalación.");
    }
    return state;
  }

  async load(userId: string): Promise<TaskCenterReadState> {
    const paths = await this.paths(userId);
    const manager = new ResourceLockManager({ rootDirectory: paths.lockRoot });
    const state = await manager.withLock("task-center", () => this.readUnlocked(userId, paths.statePath));
    return { readTaskIds: [...state.readTaskIds], preferences: { ...state.preferences } };
  }

  async update(
    userId: string,
    input: { markRead?: string[]; preferences?: TaskNotificationPreferences },
  ): Promise<TaskCenterReadState> {
    if (input.markRead?.some((id) => !isTaskCenterId(id))) {
      throw new WorkbenchValidationError("La tarea que intentas marcar no es válida.");
    }
    const paths = await this.paths(userId);
    const manager = new ResourceLockManager({ rootDirectory: paths.lockRoot });
    const state = await manager.withLock("task-center", async () => {
      const current = await this.readUnlocked(userId, paths.statePath);
      const readTaskIds = input.markRead
        ? [...new Set([...current.readTaskIds, ...input.markRead])].slice(-MAX_READ_TASKS)
        : current.readTaskIds;
      const next: StoredTaskCenterState = {
        ...current,
        readTaskIds,
        preferences: input.preferences ? { ...input.preferences } : current.preferences,
        updatedAt: new Date().toISOString(),
      };
      await atomicWriteJson(paths.statePath, next, taskCenterStateSchema);
      return next;
    });
    return { readTaskIds: [...state.readTaskIds], preferences: { ...state.preferences } };
  }
}
