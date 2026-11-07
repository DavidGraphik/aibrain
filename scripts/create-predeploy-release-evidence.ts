import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const PREDEPLOY_RELEASE_EVIDENCE_KIND = "aibrain-predeploy-release-evidence";
export const PREDEPLOY_RELEASE_EVIDENCE_VERSION = 1;

const SHA = /^[0-9a-f]{40}$/u;
const OCI_DIGEST = /^sha256:[0-9a-f]{64}$/u;

export type ReleaseIdentityInput = {
  candidateSha: string;
  ciSha: string;
  deploySha: string;
  runtimeSha: string;
  appOciRevision: string;
  gatewayOciRevision: string;
  appOciDigest: string;
  gatewayOciDigest: string;
};

type ScriptFingerprint = {
  path: string;
  sha256: string;
};

export type PredeployReleaseEvidence = {
  schemaVersion: typeof PREDEPLOY_RELEASE_EVIDENCE_VERSION;
  kind: typeof PREDEPLOY_RELEASE_EVIDENCE_KIND;
  releaseSha: string;
  identity: ReleaseIdentityInput;
  backup: {
    orchestrator: ScriptFingerprint;
    restoreCli: ScriptFingerprint;
    verificationRequired: true;
    isolatedRestoreRequired: true;
  };
  rollback: {
    manager: ScriptFingerprint;
    previousReleaseRequired: true;
  };
};

const REQUIRED_SCRIPTS = {
  orchestrator: "scripts/orchestrate-backup.mjs",
  restoreCli: "scripts/backup.ts",
  manager: "scripts/manage-release.mjs",
} as const;

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireReleaseIdentity(identity: ReleaseIdentityInput): void {
  for (const [name, value] of Object.entries(identity)) {
    const valid = name.endsWith("Digest") ? OCI_DIGEST.test(value) : SHA.test(value);
    if (!valid) throw new Error(`Invalid ${name}; release evidence requires a full immutable identifier.`);
  }
  for (const [name, value] of Object.entries(identity)) {
    if (!name.endsWith("Digest") && value !== identity.candidateSha) {
      throw new Error(`Release identity drift at ${name}; all recorded revisions must equal candidateSha.`);
    }
  }
}

async function fingerprint(sourceRoot: string, scriptPath: string): Promise<ScriptFingerprint> {
  const absolutePath = path.resolve(sourceRoot, scriptPath);
  return { path: scriptPath, sha256: digest(await readFile(absolutePath)) };
}

export async function createPredeployReleaseEvidence(
  identity: ReleaseIdentityInput,
  sourceRoot: string,
): Promise<PredeployReleaseEvidence> {
  requireReleaseIdentity(identity);
  const [orchestrator, restoreCli, manager] = await Promise.all([
    fingerprint(sourceRoot, REQUIRED_SCRIPTS.orchestrator),
    fingerprint(sourceRoot, REQUIRED_SCRIPTS.restoreCli),
    fingerprint(sourceRoot, REQUIRED_SCRIPTS.manager),
  ]);
  return {
    schemaVersion: PREDEPLOY_RELEASE_EVIDENCE_VERSION,
    kind: PREDEPLOY_RELEASE_EVIDENCE_KIND,
    releaseSha: identity.candidateSha,
    identity,
    backup: {
      orchestrator,
      restoreCli,
      verificationRequired: true,
      isolatedRestoreRequired: true,
    },
    rollback: {
      manager,
      previousReleaseRequired: true,
    },
  };
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const output = option(args, "--output");
  const identity: ReleaseIdentityInput = {
    candidateSha: option(args, "--candidate-sha") ?? "",
    ciSha: option(args, "--ci-sha") ?? "",
    deploySha: option(args, "--deploy-sha") ?? "",
    runtimeSha: option(args, "--runtime-sha") ?? "",
    appOciRevision: option(args, "--app-oci-revision") ?? "",
    gatewayOciRevision: option(args, "--gateway-oci-revision") ?? "",
    appOciDigest: option(args, "--app-oci-digest") ?? "",
    gatewayOciDigest: option(args, "--gateway-oci-digest") ?? "",
  };
  if (!output) {
    process.stderr.write("Usage: npm run acceptance:release-evidence -- --output <new-private-json> --candidate-sha <sha> --ci-sha <sha> --deploy-sha <sha> --runtime-sha <sha> --app-oci-revision <sha> --gateway-oci-revision <sha> --app-oci-digest <sha256:...> --gateway-oci-digest <sha256:...>\n");
    process.exitCode = 64;
    return;
  }
  const evidence = await createPredeployReleaseEvidence(identity, process.cwd());
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
