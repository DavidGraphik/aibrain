import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { loadInstallationConfig } from "../src/config/installation";
import { UserProvisioner } from "../src/users";
import { FileWorkspaceAdminStore } from "../src/admin/workspace-admin-store";

/** Explicit, repeatable operator setup. Auth identities must already exist. */
async function main() {
  const index = process.argv.indexOf("--manifest");
  const file = index >= 0 ? process.argv[index + 1] : undefined;
  if (!process.argv.includes("--offline-worker-stopped") || !file || !path.isAbsolute(file)) throw Error("TRINALUM_OFFLINE_MANIFEST_REQUIRED");
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw Error("TRINALUM_MANIFEST_INVALID");
  const config = await loadInstallationConfig();
  if (config.installationId !== "trinalum-production" || config.companySlug !== "trinalum") throw Error("TRINALUM_INSTALLATION_REQUIRED");
  const inputs = JSON.parse(await readFile(file, "utf8")) as { userId: string; email: string; displayName: string }[];
  // Identity bindings belong to the operator's private environment, never the public source.
  const expectedEmails = (process.env.AIBRAIN_PROVISIONING_ALLOWED_EMAILS ?? "").split(",").map(value => value.trim()).filter(Boolean);
  const ownerEmail = process.env.AIBRAIN_PROVISIONING_OWNER_EMAIL?.trim();
  const adminEmail = process.env.AIBRAIN_PROVISIONING_ADMIN_EMAIL?.trim();
  const emails = new Set(expectedEmails);
  if (emails.size !== 5 || expectedEmails.length !== 5 || !ownerEmail || !adminEmail || ownerEmail === adminEmail || !emails.has(ownerEmail) || !emails.has(adminEmail)) throw Error("TRINALUM_IDENTITY_BINDINGS_REQUIRED");
  if (!Array.isArray(inputs) || inputs.length !== 5 || new Set(inputs.map(u => u.userId)).size !== 5 || new Set(inputs.map(u => u.email)).size !== 5 || inputs.some(u => !emails.has(u.email))) throw Error("TRINALUM_MANIFEST_INVALID");
  const owner = inputs.find(u => u.email === ownerEmail)!;
  const admin = inputs.find(u => u.email === adminEmail)!;
  if (process.env.AIBRAIN_ADMIN_USER_IDS !== `${owner.userId},${admin.userId}`) throw Error("TRINALUM_OWNER_BOOTSTRAP_REQUIRED");
  const provisioner = new UserProvisioner(config, { companyContextSeedRoot: "/etc/aibrain/trinalum-company-context" });
  let created = 0;
  for (const input of inputs) {
    const result = await provisioner.provision({ userId: input.userId, email: input.email, displayName: input.displayName, enabled: true, requireInitialPasswordChange: input.email !== adminEmail });
    if (result.created) created++;
  }
  const state = await new FileWorkspaceAdminStore(config.installationId, config.paths.dataRoot).read(inputs.map(u => u.userId));
  if (state.assignments.find(a => a.userId === owner.userId)?.roleId !== "workspace-owner" || state.assignments.find(a => a.userId === admin.userId)?.roleId !== "workspace-admin") throw Error("TRINALUM_ROLE_MISMATCH");
  process.stdout.write(JSON.stringify({ installationId: config.installationId, requested: inputs.length, created, unchanged: inputs.length - created, rolesVerified: true, emailsSent: false }) + "\n");
}
void main().catch(error => { process.stderr.write((error instanceof Error && /^TRINALUM_[A-Z_]+$/.test(error.message) ? error.message : "TRINALUM_PROVISIONING_FAILED") + "\n"); process.exitCode = 1; });
