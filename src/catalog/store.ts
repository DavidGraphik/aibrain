import { chmod, lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  CATALOG_SCHEMA_VERSION,
  CATALOG_ID,
  CATALOG_UUID,
  isCatalogResource,
  isCatalogRule,
  type CatalogAuditEvent,
  type CatalogResource,
  type CatalogRule,
  type CatalogState,
} from "@/catalog/contracts";
import {
  atomicWriteJson,
  defineVersionedSchema,
  expectInteger,
  expectIsoDate,
  expectString,
  FileJournal,
  recoverAtomicJsonFile,
  ResourceLockManager,
  type ValidationContext,
} from "@/storage";

const INSTALLATION_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function resource(value: unknown, context: ValidationContext): CatalogResource {
  if (!isCatalogResource(value)) context.fail("expected a valid catalog resource");
  return structuredClone(value);
}

function rule(value: unknown, context: ValidationContext): CatalogRule {
  if (!isCatalogRule(value)) context.fail("expected a valid catalog rule");
  return structuredClone(value);
}

export const catalogStateSchema = defineVersionedSchema<CatalogState>({
  name: "CatalogState",
  schemaVersion: CATALOG_SCHEMA_VERSION,
  keys: ["installationId", "revision", "resources", "rules"],
  parse(record, context) {
    const resources = Array.isArray(record.resources) ? record.resources.map((item, index) => resource(item, context.at(`resources[${index}]`))) : context.at("resources").fail("expected an array");
    const rules = Array.isArray(record.rules) ? record.rules.map((item, index) => rule(item, context.at(`rules[${index}]`))) : context.at("rules").fail("expected an array");
    if (resources.length > 500 || new Set(resources.map(({ id }) => id)).size !== resources.length) context.at("resources").fail("resource ids must be unique and bounded");
    if (rules.length > 5_000 || new Set(rules.map(({ id }) => id)).size !== rules.length) context.at("rules").fail("rule ids must be unique and bounded");
    if (rules.some((item) => !resources.some((candidate) => candidate.id === item.resourceId))) context.at("rules").fail("every rule must reference an existing resource");
    return {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      installationId: expectString(record.installationId, context.at("installationId"), { minLength: 2, maxLength: 63, pattern: INSTALLATION_ID }),
      revision: expectInteger(record.revision, context.at("revision"), { minimum: 0 }), resources, rules,
    };
  },
});

export const catalogAuditEventSchema = defineVersionedSchema<CatalogAuditEvent>({
  name: "CatalogAuditEvent", schemaVersion: 1,
  keys: ["installationId", "actorUserId", "action", "targetId", "summary", "occurredAt"],
  parse(record, context) {
    if (record.action !== "catalog.resource-upserted" && record.action !== "catalog.rule-set") context.at("action").fail("unexpected catalog audit action");
    const action = record.action as CatalogAuditEvent["action"];
    return {
      schemaVersion: 1,
      installationId: expectString(record.installationId, context.at("installationId"), { minLength: 2, maxLength: 63, pattern: INSTALLATION_ID }),
      actorUserId: expectString(record.actorUserId, context.at("actorUserId"), { minLength: 36, maxLength: 36, pattern: CATALOG_UUID }),
      action, targetId: expectString(record.targetId, context.at("targetId"), { minLength: 1, maxLength: 128, pattern: CATALOG_ID }),
      summary: expectString(record.summary, context.at("summary"), { minLength: 1, maxLength: 300 }),
      occurredAt: expectIsoDate(record.occurredAt, context.at("occurredAt")),
    };
  },
});

function missing(error: unknown) { return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"); }

export class FileCatalogStore {
  private readonly root: string;
  private readonly statePath: string;
  private readonly locks: ResourceLockManager;
  private readonly audit: FileJournal<CatalogAuditEvent>;

  constructor(readonly installationId: string, dataRoot: string, private readonly now: () => number = Date.now) {
    if (!INSTALLATION_ID.test(installationId) || !path.isAbsolute(dataRoot)) throw new Error("Catalog store options are invalid.");
    this.root = path.join(path.resolve(dataRoot), "catalog");
    this.statePath = path.join(this.root, "state.json");
    this.locks = new ResourceLockManager({ rootDirectory: path.join(this.root, "locks") });
    this.audit = new FileJournal({ filePath: path.join(this.root, "audit.jsonl"), lockManager: new ResourceLockManager({ rootDirectory: path.join(this.root, "audit-locks") }), payloadSchema: catalogAuditEventSchema, now });
  }

  private async prepare() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Catalog storage root is unsafe.");
    await chmod(this.root, 0o700);
  }

  private async readUnlocked() {
    try {
      const state = (await recoverAtomicJsonFile(this.statePath, catalogStateSchema)).value;
      if (state.installationId !== this.installationId) throw new Error("Catalog state belongs to another installation.");
      return state;
    } catch (error) {
      if (!missing(error)) throw error;
      const initial = catalogStateSchema.parse({ schemaVersion: CATALOG_SCHEMA_VERSION, installationId: this.installationId, revision: 0, resources: [], rules: [] });
      await atomicWriteJson(this.statePath, initial, catalogStateSchema, { mode: 0o600 });
      return initial;
    }
  }

  async read() {
    await this.prepare();
    return this.locks.withLock(`catalog:${this.installationId}`, async () => structuredClone(await this.readUnlocked()));
  }

  /** Adds only immutable GraphikAI baseline skills; it never removes history. */
  async ensureManagedSkills(skills: readonly { id: string; label: string }[]) {
    if (skills.length === 0) return this.read();
    await this.prepare();
    return this.locks.withLock(`catalog:${this.installationId}`, async () => {
      const state = await this.readUnlocked();
      let changed = false;
      for (const skill of skills) {
        const existing = state.resources.find((resource) => resource.id === skill.id);
        if (existing) {
          if (existing.managedBy !== "graphikai" || existing.kind !== "skill") {
            throw new Error(`Catalog baseline skill ${skill.id} conflicts with a company resource.`);
          }
          continue;
        }
        state.resources.push({ id: skill.id, kind: "skill", label: skill.label, credentialMode: "none", managedBy: "graphikai", sharedResource: false, appId: null, connectorId: null, mcp: null });
        state.rules.push({ id: `installation-${skill.id}`, scope: "installation", subjectId: null, resourceId: skill.id, effect: "allow", operations: ["read"] });
        changed = true;
      }
      if (changed) {
        state.revision += 1;
        await atomicWriteJson(this.statePath, catalogStateSchema.parse(state), catalogStateSchema, { mode: 0o600 });
      }
      return structuredClone(state);
    });
  }

  /** Reconciles immutable GraphikAI connector baselines with installation config. */
  async ensureManagedResources(resources: readonly CatalogResource[], managedResourceIds: readonly string[] = resources.map(({ id }) => id), initialWriteResourceIds: readonly string[] = []) {
    await this.prepare();
    return this.locks.withLock(`catalog:${this.installationId}`, async () => {
      const state = await this.readUnlocked();
      let changed = false;
      const configuredIds = new Set(resources.map(({ id }) => id));
      if (initialWriteResourceIds.some(id => !configuredIds.has(id))) throw new Error("A default write grant requires a configured resource.");
      const reconciledIds = new Set(managedResourceIds);
      const removedIds = new Set(state.resources
        .filter((resource) => reconciledIds.has(resource.id) && resource.managedBy === "graphikai" && resource.kind !== "skill" && !configuredIds.has(resource.id))
        .map(({ id }) => id));
      if (removedIds.size > 0) {
        state.resources = state.resources.filter((resource) => !removedIds.has(resource.id));
        state.rules = state.rules.filter((rule) => !removedIds.has(rule.resourceId));
        changed = true;
      }
      for (const candidate of resources) {
        if (!isCatalogResource(candidate) || candidate.managedBy !== "graphikai" || candidate.kind === "skill") {
          throw new Error(`Catalog baseline resource ${candidate.id} is invalid.`);
        }
        const existing = state.resources.find((resource) => resource.id === candidate.id);
        if (existing) {
          if (JSON.stringify(existing) !== JSON.stringify(candidate)) {
            throw new Error(`Catalog baseline resource ${candidate.id} conflicts with durable state.`);
          }
        } else {
          state.resources.push(structuredClone(candidate));
          changed = true;
        }
        const ruleId = `installation-${candidate.id}`;
        const existingRule = state.rules.find((rule) => rule.id === ruleId);
        if (!existingRule) {
          // Initial defaults never replace a durable operator rule or denial.
          state.rules.push({ id: ruleId, scope: "installation", subjectId: null, resourceId: candidate.id, effect: "allow", operations: initialWriteResourceIds.includes(candidate.id) ? ["read", "write"] : ["read"] });
          changed = true;
        }
      }
      if (changed) {
        state.revision += 1;
        await atomicWriteJson(this.statePath, catalogStateSchema.parse(state), catalogStateSchema, { mode: 0o600 });
      }
      return structuredClone(state);
    });
  }

  async mutate(actorUserId: string, operation: (state: CatalogState) => Omit<CatalogAuditEvent, "schemaVersion" | "installationId" | "actorUserId" | "occurredAt">) {
    await this.prepare();
    const result = await this.locks.withLock(`catalog:${this.installationId}`, async () => {
      const state = await this.readUnlocked();
      const audit = operation(state);
      state.revision += 1;
      const parsed = catalogStateSchema.parse(state);
      await atomicWriteJson(this.statePath, parsed, catalogStateSchema, { mode: 0o600 });
      return { state: structuredClone(parsed), audit };
    });
    await this.audit.append({ schemaVersion: 1, installationId: this.installationId, actorUserId, ...result.audit, occurredAt: new Date(this.now()).toISOString() });
    return result.state;
  }

  async auditLog(limit = 100) { return (await this.audit.read({ limit })).reverse().map(({ sequence, payload }) => ({ sequence, ...payload })); }
}
