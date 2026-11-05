import { execFile } from "node:child_process";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const invoke = promisify(execFile);
let root: string;
let registryFile: string;
const registry = () => ({
  ...Object.fromEntries(privateIds.map(id => [id, { repository: privateRepository, imageRepository: "ghcr.io/example-owner/graphikai-brain", egressImageRepository: "ghcr.io/example-owner/graphikai-brain-egress" }])),
  "company-qa": { repository: publicRepository, imageRepository: "ghcr.io/upstream-example/aibrain", egressImageRepository: "ghcr.io/upstream-example/aibrain-egress" },
});
beforeEach(async () => {
  root = await mkdtemp(path.join((await import("node:os")).tmpdir(), "ownership-public-test-"));
  registryFile = path.join(root, "ownership.json");
  await writeFile(registryFile, JSON.stringify(registry()), { mode: 0o600 });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
function execFileAsync(file: string, args: string[]) {
  return invoke(file, args, { env: { ...process.env, AIBRAIN_RELEASE_OWNERSHIP_FILE: registryFile } });
}
const privateRepository = "example-owner/aibrain";
const publicRepository = "upstream-example/aibrain";
const privateIds = ["trinalum-production", "g03-production", "insijets-demo", "modtime"];
const script = path.join(process.cwd(), "scripts/verify-release-ownership.mjs");
const image = (repository: string) => `${repository}@sha256:${"a".repeat(64)}`;
function args(id: string, source = privateRepository, app = "ghcr.io/example-owner/graphikai-brain", egress = "ghcr.io/example-owner/graphikai-brain-egress") {
  return [script, "--installation-id", id, "--source-repository", source, "--image", image(app), "--egress-image", image(egress)];
}

describe("installation release ownership", () => {
  it.each(privateIds)("keeps %s eligible for the private source and images", async (id) => {
    const { stdout } = await execFileAsync(process.execPath, args(id));
    expect(JSON.parse(stdout)).toMatchObject({ installationId: id, repository: privateRepository, eligible: true });
  });

  it.each(privateIds)("refuses public substitution for private client %s", async (id) => {
    await expect(execFileAsync(process.execPath, args(id, publicRepository, "ghcr.io/upstream-example/aibrain", "ghcr.io/upstream-example/aibrain-egress")))
      .rejects.toMatchObject({ stderr: expect.stringContaining("RELEASE_OWNERSHIP_MISMATCH") });
  });

  it("refuses company-qa in any private promotion selection", async () => {
    await expect(execFileAsync(process.execPath, args("company-qa")))
      .rejects.toMatchObject({ stderr: expect.stringContaining("RELEASE_OWNERSHIP_MISMATCH") });
    await expect(execFileAsync(process.execPath, args("company-qa", privateRepository, "ghcr.io/upstream-example/aibrain", "ghcr.io/upstream-example/aibrain-egress")))
      .rejects.toMatchObject({ stderr: expect.stringContaining("RELEASE_OWNERSHIP_MISMATCH") });
  });

  it("allows Arnall only from Arnau with both public immutable images", async () => {
    const { stdout } = await execFileAsync(process.execPath, args("company-qa", publicRepository, "ghcr.io/upstream-example/aibrain", "ghcr.io/upstream-example/aibrain-egress"));
    expect(JSON.parse(stdout)).toMatchObject({ installationId: "company-qa", repository: publicRepository, eligible: true });
  });

  it.each(["unknown-installation", "Arnall", "arnall", "constructor", "__proto__"])("fails closed for unregistered installation %s", async (id) => {
    await expect(execFileAsync(process.execPath, args(id)))
      .rejects.toMatchObject({ stderr: expect.stringContaining("RELEASE_OWNERSHIP_UNKNOWN") });
  });

  it("rejects duplicate flags rather than letting the last selection win", async () => {
    await expect(execFileAsync(process.execPath, [...args("company-qa"), "--installation-id", "modtime"]))
      .rejects.toMatchObject({ stderr: expect.stringContaining("RELEASE_OWNERSHIP_USAGE") });
  });

  it("uses only the injected registry and denies every installation without one", async () => {
    const owners = JSON.parse(await readFile(registryFile, "utf8"));
    for (const id of privateIds) expect(owners[id].repository).toBe(privateRepository);
    expect(owners["company-qa"].repository).toBe(publicRepository);
    await expect(invoke(process.execPath, args("company-qa"), { env: { ...process.env, AIBRAIN_RELEASE_OWNERSHIP_FILE: "" } }))
      .rejects.toMatchObject({ stderr: expect.stringContaining("RELEASE_OWNERSHIP_UNKNOWN") });
  });
});
