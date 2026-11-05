import { readFile } from "node:fs/promises";
import { loadInstallationConfig } from "../src/config/installation";
import { FileCatalogStore } from "../src/catalog/store";
import { TRINALUM_CONNECTOR_RESOURCES } from "../src/connectors/trinalum-capabilities";

async function main() {
  const file = process.argv[process.argv.indexOf("--manifest") + 1];
  if (!file?.startsWith("/") || !process.argv.includes("--offline-worker-stopped")) throw Error("OFFLINE_MANIFEST_REQUIRED");
  const config = await loadInstallationConfig();
  if (config.installationId !== "trinalum-production") throw Error("TRINALUM_INSTALLATION_REQUIRED");
  const users = JSON.parse(await readFile(file, "utf8")) as { userId: string; email: string }[];
  const operatorEmail = process.env.AIBRAIN_PROVISIONING_ADMIN_EMAIL?.trim();
  if (!operatorEmail) throw Error("OPERATOR_IDENTITY_BINDING_REQUIRED");
  const operator = users.find(user => user.email === operatorEmail);
  if (!operator) throw Error("OPERATOR_REQUIRED");
  const store = new FileCatalogStore(config.installationId, config.paths.dataRoot);
  for (const resource of TRINALUM_CONNECTOR_RESOURCES) {
    await store.mutate(operator.userId, state => {
      const existing = state.resources.find(value => value.id === resource.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(resource)) throw Error("RESOURCE_CONFLICT");
      if (!existing) state.resources.push(resource);
      const id = `installation-${resource.id}`;
      if (!state.rules.some(rule => rule.id === id)) state.rules.push({ id, scope: "installation", subjectId: null, resourceId: resource.id, effect: "allow", operations: ["read"] });
      return { action: "catalog.resource-upserted", targetId: resource.id, summary: "Trinalum connector tile; live broker binding remains the authorization boundary." };
    });
  }
  process.stdout.write(JSON.stringify({ installationId: config.installationId, connectors: TRINALUM_CONNECTOR_RESOURCES.map(resource => resource.label) }) + "\n");
}
void main().catch(() => { process.stderr.write("TRINALUM_CATALOG_PROVISIONING_FAILED\n"); process.exitCode = 1; });
