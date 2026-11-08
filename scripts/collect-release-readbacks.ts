import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const IMAGE = /^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$/u;
const CONTAINER = /^[a-f0-9]{12,64}$/u;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const secretPatterns = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/iu,
  /\b(?:cookie|password|secret|access[_-]?token|refresh[_-]?token)\s*[:=]\s*\S+/iu,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
];

export const RELEASE_READBACK_ROUTES = [
  "release:ci-readback",
  "release:deploy-state",
  "release:runtime-readback",
  "release:app-oci-inspect",
  "release:gateway-oci-inspect",
] as const;

export type ReleaseReadbackRoute = (typeof RELEASE_READBACK_ROUTES)[number];

export type CommandAdapter = {
  run(args: string[]): Promise<string>;
};

export type ReleaseReadback = {
  route: ReleaseReadbackRoute;
  artifactPath: string;
  value: Record<string, unknown>;
};

export type CollectReleaseReadbacksInput = {
  candidateSha: string;
  pipelineSourcePath: string;
  releaseStatePath: string;
  appContainer: string;
  gatewayContainer: string;
  command: CommandAdapter;
  capturedAt?: string;
};

type ReleaseState = {
  current: { revision: string; image: string; egressImage: string };
};

type PipelineIdentity = {
  backendCiRunId: string;
  publishRunId: string;
  deployRunId: string;
  appDigest: string;
  gatewayDigest: string;
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

function assertNoSecrets(value: string, label: string): void {
  const decodedCandidates = value.match(/[A-Za-z0-9+/]{24,}={0,2}/gu) ?? [];
  const inspected = [value, ...decodedCandidates.flatMap((candidate) => {
    try {
      return [Buffer.from(candidate, "base64").toString("utf8")];
    } catch {
      return [];
    }
  })];
  if (inspected.some((text) => secretPatterns.some((pattern) => pattern.test(text)))) {
    throw new Error(`${label} contains secret-shaped material.`);
  }
}

async function readSource(pathname: string, label: string): Promise<{ text: string; fingerprint: string }> {
  let stat;
  try {
    stat = await lstat(pathname);
  } catch {
    throw new Error(`${label} is unavailable.`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o022) !== 0 || stat.size > 1024 * 1024) {
    throw new Error(`${label} must be a bounded, non-writable regular file.`);
  }
  const text = await readFile(pathname, "utf8");
  assertNoSecrets(text, label);
  return { text, fingerprint: sha256(text) };
}

async function readJsonSource(pathname: string, label: string): Promise<{ value: unknown; fingerprint: string }> {
  const source = await readSource(pathname, label);
  try {
    return { value: JSON.parse(source.text) as unknown, fingerprint: source.fingerprint };
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function parseRun(
  value: unknown,
  workflow: "Backend CI" | "Publish GHCR images" | "Deploy Arnall",
  candidateSha: string,
  conclusionRequired: boolean,
): string {
  const keys = conclusionRequired ? ["workflow", "conclusion", "headSha", "runId"] : ["workflow", "headSha", "runId"];
  if (!isRecord(value) || !hasExactKeys(value, keys)
    || value.workflow !== workflow
    || value.headSha !== candidateSha
    || typeof value.runId !== "string"
    || !/^[0-9][0-9]{5,20}$/u.test(value.runId)
    || (conclusionRequired && value.conclusion !== "success")) {
    throw new Error(`${workflow} source does not match the verified GitHub Actions contract.`);
  }
  return value.runId;
}

function parsePipelineReadback(value: unknown, candidateSha: string): PipelineIdentity {
  if (!isRecord(value)
    || !hasExactKeys(value, ["schemaVersion", "headSha", "backendCi", "publish", "deploy", "images"])
    || value.schemaVersion !== 2
    || value.headSha !== candidateSha
    || !isRecord(value.images)
    || !hasExactKeys(value.images, ["appDigest", "gatewayDigest"])
    || typeof value.images.appDigest !== "string"
    || typeof value.images.gatewayDigest !== "string"
    || !DIGEST.test(value.images.appDigest)
    || !DIGEST.test(value.images.gatewayDigest)) {
    throw new Error("Pipeline source does not match the sanitized release correlation contract.");
  }
  const backendCiRunId = parseRun(value.backendCi, "Backend CI", candidateSha, true);
  const publishRunId = parseRun(value.publish, "Publish GHCR images", candidateSha, true);
  const deployRunId = parseRun(value.deploy, "Deploy Arnall", candidateSha, false);
  if (new Set([backendCiRunId, publishRunId, deployRunId]).size !== 3) {
    throw new Error("Backend CI, Publish and Deploy must have distinct GitHub Actions run IDs.");
  }
  return {
    backendCiRunId,
    publishRunId,
    deployRunId,
    appDigest: value.images.appDigest,
    gatewayDigest: value.images.gatewayDigest,
  };
}

function parseReleaseState(value: unknown, candidateSha: string): ReleaseState {
  if (!isRecord(value) || value.schemaVersion !== 3 || !isRecord(value.current)
    || typeof value.current.revision !== "string" || typeof value.current.image !== "string" || typeof value.current.egressImage !== "string"
    || !SHA.test(value.current.revision) || !IMAGE.test(value.current.image) || !IMAGE.test(value.current.egressImage)) {
    throw new Error("Release state is missing an immutable current release.");
  }
  if (value.current.revision !== candidateSha) throw new Error("Deploy state revision does not match the requested candidate.");
  return { current: { revision: value.current.revision, image: value.current.image, egressImage: value.current.egressImage } };
}

function imageDigest(image: string): string {
  return image.slice(image.indexOf("@") + 1);
}

async function command(adapter: CommandAdapter, args: string[], label: string): Promise<string> {
  const output = (await adapter.run(args)).trim();
  assertNoSecrets(output, label);
  if (!output) throw new Error(`${label} returned no value.`);
  return output;
}

async function inspectContainer(adapter: CommandAdapter, container: string, expectedImage: string, candidateSha: string): Promise<{ revision: string; provenance: string }> {
  if (!CONTAINER.test(container)) throw new Error("Container identity must be a Docker container ID.");
  const imageArgs = ["inspect", "--format", "{{.Config.Image}}", container];
  const revisionArgs = ["inspect", "--format", "{{index .Config.Labels \"org.opencontainers.image.revision\"}}", container];
  const [image, revision] = await Promise.all([
    command(adapter, imageArgs, "Container image inspection"),
    command(adapter, revisionArgs, "Container revision inspection"),
  ]);
  if (image !== expectedImage || revision !== candidateSha) {
    throw new Error("Running container image or revision does not match release state.");
  }
  return { revision, provenance: sha256(JSON.stringify({ imageArgs, image, revisionArgs, revision })) };
}

async function inspectAppRuntimeRevision(adapter: CommandAdapter, container: string, candidateSha: string): Promise<{ revision: string; provenance: string }> {
  const environmentArgs = ["inspect", "--format", "{{json .Config.Env}}", container];
  const environmentText = await command(adapter, environmentArgs, "Application runtime environment inspection");
  let environment: unknown;
  try {
    environment = JSON.parse(environmentText) as unknown;
  } catch {
    throw new Error("Application runtime environment inspection did not return JSON.");
  }
  const revisions = Array.isArray(environment)
    ? environment.filter((item): item is string => typeof item === "string" && item.startsWith("AIBRAIN_REVISION="))
    : [];
  if (revisions.length !== 1 || revisions[0] !== `AIBRAIN_REVISION=${candidateSha}`) {
    throw new Error("Application runtime revision does not match the candidate.");
  }
  return { revision: candidateSha, provenance: sha256(JSON.stringify({ environmentArgs, revisions })) };
}

async function inspectImage(adapter: CommandAdapter, image: string, candidateSha: string): Promise<{ digest: string; revision: string; provenance: string }> {
  const digestsArgs = ["image", "inspect", "--format", "{{json .RepoDigests}}", image];
  const revisionArgs = ["image", "inspect", "--format", "{{index .Config.Labels \"org.opencontainers.image.revision\"}}", image];
  const [digestsText, revision] = await Promise.all([
    command(adapter, digestsArgs, "Image digest inspection"),
    command(adapter, revisionArgs, "Image revision inspection"),
  ]);
  let digests: unknown;
  try {
    digests = JSON.parse(digestsText) as unknown;
  } catch {
    throw new Error("Image digest inspection did not return JSON.");
  }
  const digest = imageDigest(image);
  if (!Array.isArray(digests) || !digests.some((item) => typeof item === "string" && item.endsWith(digest)) || revision !== candidateSha) {
    throw new Error("Immutable image digest or OCI revision does not match the candidate.");
  }
  return { digest, revision, provenance: sha256(JSON.stringify({ digestsArgs, digests, revisionArgs, revision })) };
}

function provenance(kind: "file" | "docker-command", fingerprint: string) {
  return { kind, sha256: fingerprint };
}

function capturedAt(input: string | undefined): string {
  const value = input ?? new Date().toISOString();
  if (!timestampPattern.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("capturedAt must be an ISO UTC timestamp.");
  return value;
}

export async function collectReleaseReadbacks(input: CollectReleaseReadbacksInput): Promise<ReleaseReadback[]> {
  if (!SHA.test(input.candidateSha)) throw new Error("candidateSha must be a full immutable Git SHA.");
  const at = capturedAt(input.capturedAt);
  const [pipelineSource, stateSource] = await Promise.all([
    readJsonSource(input.pipelineSourcePath, "Pipeline source"),
    readJsonSource(input.releaseStatePath, "Release state"),
  ]);
  const pipeline = parsePipelineReadback(pipelineSource.value, input.candidateSha);
  const ciSha = input.candidateSha;
  const state = parseReleaseState(stateSource.value, input.candidateSha);
  const [appRuntime, gatewayRuntime, appImage, gatewayImage] = await Promise.all([
    inspectContainer(input.command, input.appContainer, state.current.image, input.candidateSha),
    inspectContainer(input.command, input.gatewayContainer, state.current.egressImage, input.candidateSha),
    inspectImage(input.command, state.current.image, input.candidateSha),
    inspectImage(input.command, state.current.egressImage, input.candidateSha),
  ]);
  const appEnvironment = await inspectAppRuntimeRevision(input.command, input.appContainer, input.candidateSha);
  if (appRuntime.revision !== gatewayRuntime.revision || appImage.revision !== gatewayImage.revision) {
    throw new Error("Runtime or OCI revisions are not mutually consistent.");
  }
  if (pipeline.appDigest !== appImage.digest || pipeline.gatewayDigest !== gatewayImage.digest) {
    throw new Error("Published GHCR digests do not match deploy state and OCI inspection.");
  }
  return [
    {
      route: "release:ci-readback", artifactPath: "release-ci-readback.json",
      value: {
        schemaVersion: 1,
        kind: "aibrain-release-ci-readback",
        source: "ci",
        candidateSha: input.candidateSha,
        ciSha,
        backendCi: { runId: pipeline.backendCiRunId, headSha: input.candidateSha },
        publish: { runId: pipeline.publishRunId, headSha: input.candidateSha },
        deploy: { runId: pipeline.deployRunId, headSha: input.candidateSha },
        appOciDigest: appImage.digest,
        gatewayOciDigest: gatewayImage.digest,
        capturedAt: at,
        provenance: provenance("file", pipelineSource.fingerprint),
      },
    },
    {
      route: "release:deploy-state", artifactPath: "release-deploy-state.json",
      value: { schemaVersion: 1, kind: "aibrain-release-deploy-state-readback", source: "deploy-state", ciSha, deploySha: state.current.revision, appOciDigest: appImage.digest, gatewayOciDigest: gatewayImage.digest, capturedAt: at, provenance: provenance("file", stateSource.fingerprint) },
    },
    {
      route: "release:runtime-readback", artifactPath: "release-runtime-readback.json",
      value: { schemaVersion: 1, kind: "aibrain-release-runtime-readback", source: "runtime", deploySha: state.current.revision, runtimeSha: appEnvironment.revision, appOciRevision: appRuntime.revision, gatewayOciRevision: gatewayRuntime.revision, capturedAt: at, provenance: provenance("docker-command", sha256(`${appRuntime.provenance}:${gatewayRuntime.provenance}:${appEnvironment.provenance}`)) },
    },
    {
      route: "release:app-oci-inspect", artifactPath: "release-app-oci-inspect.json",
      value: { schemaVersion: 1, kind: "aibrain-release-oci-inspect", source: "oci-inspect", component: "app", revision: appImage.revision, digest: appImage.digest, capturedAt: at, provenance: provenance("docker-command", appImage.provenance) },
    },
    {
      route: "release:gateway-oci-inspect", artifactPath: "release-gateway-oci-inspect.json",
      value: { schemaVersion: 1, kind: "aibrain-release-oci-inspect", source: "oci-inspect", component: "gateway", revision: gatewayImage.revision, digest: gatewayImage.digest, capturedAt: at, provenance: provenance("docker-command", gatewayImage.provenance) },
    },
  ];
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outputRoot = option(args, "--output-root");
  const dockerBin = option(args, "--docker-bin");
  const required = [outputRoot, dockerBin, option(args, "--candidate-sha"), option(args, "--pipeline-source"), option(args, "--release-state"), option(args, "--app-container"), option(args, "--gateway-container")];
  if (required.some((value) => !value)) {
    process.stderr.write("Usage: npm run acceptance:collect-release-readbacks -- --output-root <private-dir> --candidate-sha <sha> --pipeline-source <sanitized-pipeline-json> --release-state <release-state.json> --docker-bin <absolute> --app-container <id> --gateway-container <id>\n");
    process.exitCode = 64;
    return;
  }
  if (!path.isAbsolute(dockerBin!)) throw new Error("docker-bin must be an absolute command path.");
  const dockerStat = await lstat(dockerBin!);
  if (!dockerStat.isFile() || dockerStat.isSymbolicLink() || (dockerStat.mode & 0o022) !== 0) throw new Error("docker-bin must be a non-writable regular file.");
  await mkdir(outputRoot!, { recursive: true, mode: 0o700 });
  const outputStat = await lstat(outputRoot!);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink() || (outputStat.mode & 0o077) !== 0) {
    throw new Error("output-root must be a private directory.");
  }
  const readbacks = await collectReleaseReadbacks({
    candidateSha: option(args, "--candidate-sha")!, pipelineSourcePath: option(args, "--pipeline-source")!, releaseStatePath: option(args, "--release-state")!,
    appContainer: option(args, "--app-container")!, gatewayContainer: option(args, "--gateway-container")!,
    command: { run: async (commandArgs) => (await execFileAsync(dockerBin!, commandArgs, { encoding: "utf8", maxBuffer: 1024 * 1024 })).stdout },
  });
  for (const readback of readbacks) {
    await writeFile(path.join(outputRoot!, readback.artifactPath), `${JSON.stringify(readback.value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
