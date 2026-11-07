import { readFile } from "node:fs/promises";
import { loadInstallationConfig } from "../src/config/installation";
import { FileLocalUserStore } from "../src/auth/local-user-store";
import { workspacePolicyForIdentity } from "../src/admin/policy-service";
import { FileCatalogStore } from "../src/catalog/store";
import { MODTIME_REPORTING_RESOURCES, modtimeReportingEnabled } from "../src/connectors/modtime-reporting";
import { FileWorkbenchStore } from "../src/workbench/filesystem-store";
import { FileAutomationStore } from "../src/automations/store";
import { parseAutomationInput } from "../src/automations/contracts";

/** Explicit operator provisioning, never a fabricated browser session. Run with the worker stopped. */
async function main() {
  if (!process.argv.includes("--offline-worker-stopped")) throw new Error("MODTIME_WORKER_STOP_ACK_REQUIRED");
  const argument = (name: string) => process.argv[process.argv.indexOf(name) + 1];
  const ownerId = argument("--owner-id"), manifestPath = argument("--manifest");
  if (!process.argv.includes("--owner-id") || !process.argv.includes("--manifest")) throw new Error("MODTIME_ARGUMENTS_REQUIRED");
  const config = await loadInstallationConfig();
  if (!modtimeReportingEnabled(config.installationId)) throw new Error("MODTIME_INSTALLATION_REQUIRED");
  const users = new FileLocalUserStore(config.paths.usersRoot);
  const actor = await users.read(ownerId);
  const policy = await workspacePolicyForIdentity(config.installationId, ownerId, config);
  const ownerEmail = process.env.MODTIME_REPORTING_OWNER_EMAIL?.trim();
  const allowedEmails = (process.env.MODTIME_REPORTING_ALLOWED_EMAILS ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (!ownerEmail || allowedEmails.length !== 2 || new Set(allowedEmails).size !== 2 || !allowedEmails.includes(ownerEmail)) throw new Error("MODTIME_IDENTITY_BINDINGS_REQUIRED");
  if (!actor?.enabled || actor.email !== ownerEmail || !policy.role.canManageWorkspace) throw new Error("MODTIME_OWNER_REQUIRED");
  const allowedIds = process.env.MODTIME_REPORTING_USER_IDS!.split(",");
  if (allowedIds.length !== 2 || new Set(allowedIds).size !== 2 || !allowedIds.includes(ownerId)) throw new Error("MODTIME_TWO_ACTORS_REQUIRED");
  for (const id of allowedIds) {
    const user = await users.read(id);
    if (!user?.enabled || !allowedEmails.includes(user.email)) throw new Error("MODTIME_ACTOR_MISMATCH");
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.installationId !== "modtime" || manifest.ownerEmail !== actor.email || manifest.tasks?.length !== 2) throw new Error("MODTIME_MANIFEST_INVALID");
  const workbench = FileWorkbenchStore.fromInstallation(config);
  const projects = (await workbench.listProjects(ownerId, { status: "active", limit: 50 })).items;
  const plans = manifest.tasks.map((task: { name: string; prompt: string; schedule: unknown }, index: number) => {
    const projectName = index === 0 ? "Daily review & approvals" : "Catalog & SEO review";
    const project = projects.find(p => p.name === projectName);
    const input = parseAutomationInput({ ...task, projectId: project?.id, projectName, timeZone: "Europe/Madrid",
      audience: { membershipPolicy: "current", userIds: allowedIds, groupIds: [] } });
    if (!input || input.name !== (index === 0 ? "MODTIME weekly store review" : "MODTIME weekly SEO article")) throw new Error("MODTIME_TASK_INVALID");
    return { input, id: index === 0 ? "2d592228-412c-4730-a090-782285f3b394" : "06e03b45-ce9b-4c9c-ae2b-911530e5f34e" };
  });
  const tasks = new FileAutomationStore({ installationId: config.installationId, userId: ownerId, usersRoot: config.paths.usersRoot });
  const existingTasks = await tasks.list({ includeDeleted: true });
  if (plans.some((p: { id: string; input: { name: string } }) => existingTasks.some(t => t.name === p.input.name && t.id !== p.id))) throw new Error("MODTIME_DUPLICATE_TASK_NAME");
  if (process.argv.includes("--dry-run")) {
    process.stdout.write(JSON.stringify({ installationId: config.installationId, ownerId, actorCount: allowedIds.length,
      dryRun: true, tasks: plans.map((p: { id: string; input: { name: string; projectId: string } }) => ({ id: p.id, name: p.input.name, projectId: p.input.projectId, state: "paused" })) }) + "\n");
    return;
  }
  const catalog = new FileCatalogStore(config.installationId, config.paths.dataRoot);
  for (const resource of MODTIME_REPORTING_RESOURCES) {
    const state = await catalog.read();
    const existing = state.resources.find(r => r.id === resource.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(resource)) throw new Error("MODTIME_CATALOG_CONFLICT");
    if (!existing) await catalog.mutate(ownerId, s => {
      s.resources.push(resource);
      return { action: "catalog.resource-upserted", targetId: resource.id, summary: "Operator provisioned MODTIME-only read adapter with David authorization." };
    });
    for (const id of allowedIds) {
      const rule = { id: `modtime-read-${resource.id}-${id}`, scope: "user" as const, subjectId: id, resourceId: resource.id, effect: "allow" as const, operations: ["read" as const] };
      const existingRule = (await catalog.read()).rules.find(r => r.id === rule.id);
      if (existingRule && JSON.stringify(existingRule) !== JSON.stringify(rule)) throw new Error("MODTIME_RULE_CONFLICT");
      if (!existingRule) await catalog.mutate(ownerId, s => {
        s.rules.push(rule);
        return { action: "catalog.rule-set", targetId: rule.id, summary: "Operator assigned fixed MODTIME read-only connector; no write authorization." };
      });
    }
  }
  for (const plan of plans) {
    await tasks.create(plan.input, { id: plan.id });
    // Fail closed initially. A separate authenticated acceptance may activate the read-only review.
    await tasks.update(plan.id, { state: "paused" });
  }
  process.stdout.write(JSON.stringify({ installationId: config.installationId, operatorProvisionedFor: ownerId,
    tasks: (await tasks.list()).filter(t => plans.some((p: { id: string }) => p.id === t.id)).map(t => ({ id: t.id, name: t.name, state: t.state, projectId: t.projectId, audience: t.audience, nextRunAt: t.nextRunAt })) }) + "\n");
}
void main().catch(error => { process.stderr.write((error instanceof Error && /^MODTIME_[A-Z_]+$/.test(error.message) ? error.message : "MODTIME_PROVISIONING_FAILED") + "\n"); process.exitCode = 1; });
