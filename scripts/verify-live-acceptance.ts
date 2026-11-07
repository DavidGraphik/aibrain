import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";
import schema from "../tests/acceptance/live-acceptance.schema.json";
import {
  PREDEPLOY_RELEASE_EVIDENCE_KIND,
  PREDEPLOY_RELEASE_EVIDENCE_VERSION,
  type PredeployReleaseEvidence,
} from "./create-predeploy-release-evidence";

export const CANONICAL_LIVE_TARGET = "https://arnall.graphikai.com";

export const REQUIRED_LIVE_GATES = [
  "release-identity-readiness",
  "threat-model-contracts",
  "functional-desktop-mobile",
  "accessibility",
  "visual",
  "performance-concurrency",
  "failure-restart-reconnect",
  "two-user-isolation",
  "real-turn",
  "files-search-library-memory",
  "real-action-approval-readback",
  "logs-backup-rollback",
] as const;

export const PERFORMANCE_METRICS = [
  "navigationP95Ms",
  "inputP95Ms",
  "ttftP95Ms",
  "streamGapP95Ms",
  "turnTotalP95Ms",
  "reconnectP95Ms",
  "toolReadbackP95Ms",
] as const;

const GATE_REQUIREMENTS: Record<string, {
  actorCoverage?: "all";
  routes: string[];
  evidence: Array<{ kind: AcceptanceEvidence["kind"]; route: string }>;
}> = {
  "release-identity-readiness": {
    routes: ["GET /api/health/live", "GET /api/health/ready"],
    evidence: [
      { kind: "release", route: "release:identity" },
      { kind: "release", route: "release:ci-readback" },
      { kind: "release", route: "release:deploy-state" },
      { kind: "release", route: "release:runtime-readback" },
      { kind: "release", route: "release:app-oci-inspect" },
      { kind: "release", route: "release:gateway-oci-inspect" },
      { kind: "http", route: "GET /api/health/live" },
      { kind: "http", route: "GET /api/health/ready" },
    ],
  },
  "threat-model-contracts": { routes: ["contract:live-acceptance"], evidence: [{ kind: "contract", route: "contract:live-acceptance" }] },
  "functional-desktop-mobile": { routes: ["/"], evidence: [{ kind: "ui", route: "/" }] },
  accessibility: { routes: ["/"], evidence: [{ kind: "accessibility", route: "/" }] },
  visual: { routes: ["/"], evidence: [{ kind: "visual", route: "/" }] },
  "performance-concurrency": { routes: ["POST /api/chat"], evidence: [{ kind: "metric", route: "POST /api/chat" }] },
  "failure-restart-reconnect": {
    routes: ["POST /api/chat", "POST /api/runtime/turns/control"],
    evidence: [
      { kind: "restart", route: "POST /api/runtime/turns/control" },
      { kind: "reconnect", route: "POST /api/chat" },
    ],
  },
  "two-user-isolation": {
    actorCoverage: "all",
    routes: ["GET /api/workbench"],
    evidence: [{ kind: "isolation", route: "GET /api/workbench" }],
  },
  "real-turn": {
    actorCoverage: "all",
    routes: ["POST /api/chat", "GET /api/runtime/status"],
    evidence: [
      { kind: "turn", route: "POST /api/chat" },
      { kind: "readback", route: "GET /api/runtime/status" },
    ],
  },
  "files-search-library-memory": {
    actorCoverage: "all",
    routes: ["POST /api/threads/{threadId}/documents", "GET /api/library", "GET /api/search", "GET /api/memory"],
    evidence: [
      { kind: "file", route: "POST /api/threads/{threadId}/documents" },
      { kind: "library", route: "GET /api/library" },
      { kind: "search", route: "GET /api/search" },
      { kind: "memory", route: "GET /api/memory" },
    ],
  },
  "real-action-approval-readback": {
    routes: ["POST /api/runtime/approvals", "connector:operation", "connector:provider-readback"],
    evidence: [
      { kind: "connector-oauth", route: "connector:oauth" },
      { kind: "connector-approval", route: "POST /api/runtime/approvals" },
      { kind: "connector-execution", route: "connector:operation" },
      { kind: "connector-readback", route: "connector:provider-readback" },
    ],
  },
  "logs-backup-rollback": {
    routes: ["operations:logs", "backup:verify", "backup:restore", "release:rollback"],
    evidence: [
      { kind: "log", route: "operations:logs" },
      { kind: "backup", route: "backup:verify" },
      { kind: "restore", route: "backup:restore" },
      { kind: "rollback", route: "release:rollback" },
    ],
  },
};

type Environment = "local" | "ci" | "live";
type GateStatus = "passed" | "failed" | "blocked" | "skipped";

export type AcceptanceEvidence = {
  kind: "http" | "ui" | "contract" | "release" | "turn" | "approval" | "readback" | "file" | "library" | "search" | "memory" | "metric" | "restart" | "reconnect" | "isolation" | "log" | "backup" | "restore" | "rollback" | "accessibility" | "visual" | "audit" | "connector-oauth" | "connector-approval" | "connector-execution" | "connector-readback";
  artifactPath: string;
  sha256: string;
  capturedAt: string;
  route: string;
  releaseSha: string;
  connectorCorrelation?: ConnectorCorrelation;
};

export type ConnectorAction = {
  connectorId: string;
  provider: string;
  tenantId: string;
  actorId: string;
  credentialReference: string;
  authorization: "oauth" | "none";
  providerLive: boolean;
  operationId: string;
  operationType: string;
  approvalId: string;
  executionId: string;
  executionCount: number;
  providerReadbackId: string;
};

export type ConnectorCorrelation = Pick<ConnectorAction,
  "connectorId" | "provider" | "tenantId" | "actorId" | "credentialReference" | "operationId" | "approvalId" | "executionId" | "providerReadbackId">;

export type AcceptanceGate = {
  id: string;
  status: GateStatus;
  environment: Environment;
  target: string;
  releaseSha: string;
  startedAt: string;
  completedAt: string;
  actorIds: string[];
  routes: string[];
  latencyMs?: Record<string, number>;
  latencyBudgetMs?: Record<string, number>;
  connectorAction?: ConnectorAction;
  evidence: AcceptanceEvidence[];
  failures: string[];
};

export type AcceptanceManifest = {
  schemaVersion: 1;
  acceptanceKind: "prefilter" | "live";
  environment: Environment;
  target: string;
  releaseSha: string;
  tenantId: string;
  releaseIdentity: {
    candidateSha: string;
    ciSha: string;
    deploySha: string;
    runtimeSha: string;
    appOciRevision: string;
    gatewayOciRevision: string;
  };
  startedAt: string;
  completedAt: string;
  actors: Array<{ id: string; role: "member" | "admin" | "owner" | "operator" }>;
  gates: AcceptanceGate[];
  failures: Array<{
    id: string;
    severity: "critical" | "high" | "medium" | "low";
    status: "open" | "resolved";
    summary: string;
  }>;
};

export type AcceptanceEvaluation = {
  verdict: "accepted" | "rejected" | "prefilter-only";
  target: string | null;
  releaseSha: string | null;
  manifestSha256: string;
  reasons: string[];
  manifest: AcceptanceManifest | null;
};

const validator = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const shaPattern = /^[0-9a-f]{40}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const ociDigestPattern = /^sha256:[0-9a-f]{64}$/u;
const execFileAsync = promisify(execFile);
const RELEASE_READBACK_ROUTES = [
  "release:ci-readback",
  "release:deploy-state",
  "release:runtime-readback",
  "release:app-oci-inspect",
  "release:gateway-oci-inspect",
] as const;
const secretPatterns = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/iu,
  /\b(?:cookie|password|secret|access[_-]?token|refresh[_-]?token)\s*[:=]\s*\S+/iu,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
];

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function schemaErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => `schema${error.instancePath || "/"}: ${error.message ?? "invalid"}`);
}

function walkStrings(value: unknown, visit: (text: string) => void): void {
  if (typeof value === "string") visit(value);
  else if (Array.isArray(value)) value.forEach((item) => walkStrings(item, visit));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => walkStrings(item, visit));
}

function validTimestamp(value: string): boolean {
  return timestampPattern.test(value) && Number.isFinite(Date.parse(value));
}

function inWindow(value: string, start: string, end: string): boolean {
  const time = Date.parse(value);
  return time >= Date.parse(start) && time <= Date.parse(end);
}

function normalizeTarget(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function validateConnectorActionGate(gate: AcceptanceGate | undefined, manifest: AcceptanceManifest, reasons: string[]): void {
  if (!gate) return;
  const action = gate.connectorAction;
  if (!action) {
    reasons.push("connector_action_missing");
    return;
  }
  if (action.tenantId !== manifest.tenantId) reasons.push("connector_tenant_mismatch");
  if (!manifest.actors.some(({ id }) => id === action.actorId) || !gate.actorIds.includes(action.actorId)) {
    reasons.push("connector_actor_mismatch");
  }
  if (action.authorization !== "oauth") reasons.push("connector_oauth_missing");
  if (!action.credentialReference) reasons.push("connector_credential_missing");
  if (!action.providerLive) reasons.push("connector_provider_not_live");
  if (action.executionCount !== 1) reasons.push("connector_execution_not_exactly_once");
  if (/\b(?:health|capabilit(?:y|ies)|status|connected|audit)\b/iu.test(action.operationType)) {
    reasons.push("connector_operation_not_concrete");
  }
  const correlationKeys: Array<keyof ConnectorCorrelation> = [
    "connectorId", "provider", "tenantId", "actorId", "credentialReference", "operationId", "approvalId", "executionId", "providerReadbackId",
  ];
  const requiredKinds: AcceptanceEvidence["kind"][] = [
    "connector-oauth", "connector-approval", "connector-execution", "connector-readback",
  ];
  for (const kind of requiredKinds) {
    const evidence = gate.evidence.find((candidate) => candidate.kind === kind);
    if (!evidence) {
      reasons.push(`connector_evidence_missing:${kind}`);
      continue;
    }
    if (/\b(?:health|capabilit(?:y|ies)|status|connected|audit)\b/iu.test(evidence.route)) {
      reasons.push(`connector_non_action_evidence:${kind}`);
    }
    if (!evidence.connectorCorrelation) {
      reasons.push(`connector_correlation_missing:${kind}`);
      continue;
    }
    for (const key of correlationKeys) {
      if (evidence.connectorCorrelation[key] !== action[key]) reasons.push(`connector_correlation_mismatch:${kind}:${key}`);
    }
  }
  if (gate.evidence.some((evidence) => evidence.kind === "audit")) reasons.push("connector_generic_audit_rejected");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

function matchesFingerprint(value: unknown, expectedPath: string): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, ["path", "sha256"])
    && value.path === expectedPath
    && typeof value.sha256 === "string"
    && sha256Pattern.test(value.sha256);
}

function parseReleaseIdentityEvidence(
  contents: Buffer,
  manifest: AcceptanceManifest,
  label: string,
): PredeployReleaseEvidence | string {
  let record: unknown;
  try {
    record = JSON.parse(contents.toString("utf8"));
  } catch {
    return `release_identity_evidence_invalid:${label}`;
  }
  if (!isRecord(record)
    || !hasOnlyKeys(record, ["schemaVersion", "kind", "releaseSha", "identity", "backup", "rollback"])
    || record.schemaVersion !== PREDEPLOY_RELEASE_EVIDENCE_VERSION
    || record.kind !== PREDEPLOY_RELEASE_EVIDENCE_KIND
    || record.releaseSha !== manifest.releaseSha
    || !isRecord(record.identity)
    || !hasOnlyKeys(record.identity, ["candidateSha", "ciSha", "deploySha", "runtimeSha", "appOciRevision", "gatewayOciRevision", "appOciDigest", "gatewayOciDigest"])
    || !isRecord(record.backup)
    || !hasOnlyKeys(record.backup, ["orchestrator", "restoreCli", "verificationRequired", "isolatedRestoreRequired"])
    || !isRecord(record.rollback)
    || !hasOnlyKeys(record.rollback, ["manager", "previousReleaseRequired"])) {
    return `release_identity_evidence_invalid:${label}`;
  }

  const identity = record.identity as PredeployReleaseEvidence["identity"];
  if (Object.entries(manifest.releaseIdentity).some(([key, value]) => identity[key as keyof AcceptanceManifest["releaseIdentity"]] !== value)
    || !ociDigestPattern.test(identity.appOciDigest)
    || !ociDigestPattern.test(identity.gatewayOciDigest)
    || Object.entries(manifest.releaseIdentity).some(([, value]) => !shaPattern.test(value))
    || !matchesFingerprint(record.backup.orchestrator, "scripts/orchestrate-backup.mjs")
    || !matchesFingerprint(record.backup.restoreCli, "scripts/backup.ts")
    || record.backup.verificationRequired !== true
    || record.backup.isolatedRestoreRequired !== true
    || !matchesFingerprint(record.rollback.manager, "scripts/manage-release.mjs")
    || record.rollback.previousReleaseRequired !== true) {
    return `release_identity_evidence_mismatch:${label}`;
  }
  return record as unknown as PredeployReleaseEvidence;
}

function parseReadback(
  contents: Buffer,
  label: string,
  expected: Record<string, unknown>,
  allowedExtraKeys: string[] = [],
): string | null {
  try {
    const value = JSON.parse(contents.toString("utf8")) as unknown;
    if (!isRecord(value) || !hasOnlyKeys(value, [...Object.keys(expected), ...allowedExtraKeys, "capturedAt", "provenance"])
      || typeof value.capturedAt !== "string" || !validTimestamp(value.capturedAt)
      || !isRecord(value.provenance) || !hasOnlyKeys(value.provenance, ["kind", "sha256"])
      || !["file", "docker-command"].includes(String(value.provenance.kind))
      || typeof value.provenance.sha256 !== "string" || !sha256Pattern.test(value.provenance.sha256)) {
      return `release_identity_source_invalid:${label}`;
    }
    return Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue)
      ? null
      : `release_identity_source_mismatch:${label}`;
  } catch {
    return `release_identity_source_invalid:${label}`;
  }
}

function parsePipelineTrace(
  contents: Buffer,
  label: string,
  candidateSha: string,
  appOciDigest: string,
  gatewayOciDigest: string,
): string | null {
  try {
    const value = JSON.parse(contents.toString("utf8")) as unknown;
    if (!isRecord(value) || value.appOciDigest !== appOciDigest || value.gatewayOciDigest !== gatewayOciDigest) {
      return `release_identity_pipeline_trace_invalid:${label}`;
    }
    const runs = [value.backendCi, value.publish, value.deploy];
    if (runs.some((run) => !isRecord(run)
      || !hasOnlyKeys(run, ["runId", "headSha"])
      || run.headSha !== candidateSha
      || typeof run.runId !== "string"
      || !/^[0-9][0-9]{5,20}$/u.test(run.runId))) {
      return `release_identity_pipeline_trace_invalid:${label}`;
    }
    const runIds = runs.map((run) => (run as Record<string, unknown>).runId);
    return new Set(runIds).size === 3 ? null : `release_identity_pipeline_trace_invalid:${label}`;
  } catch {
    return `release_identity_pipeline_trace_invalid:${label}`;
  }
}

async function verifyCheckoutFingerprints(
  manifest: AcceptanceManifest,
  evidence: PredeployReleaseEvidence,
  checkoutRoot: string | undefined,
): Promise<string | null> {
  if (!checkoutRoot) return "release_identity_checkout_missing";
  let root: string;
  try {
    root = await realpath(checkoutRoot);
    if (!(await lstat(root)).isDirectory()) return "release_identity_checkout_missing";
    const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
    if (stdout.trim() !== manifest.releaseSha) return "release_identity_checkout_revision_mismatch";
    await execFileAsync("git", ["-C", root, "diff", "--quiet", "HEAD", "--", "scripts/orchestrate-backup.mjs", "scripts/backup.ts", "scripts/manage-release.mjs"]);
  } catch (error) {
    if (isRecord(error) && error.code === 1) return "release_identity_checkout_dirty";
    return "release_identity_checkout_unverifiable";
  }
  const expected = [
    ["scripts/orchestrate-backup.mjs", evidence.backup.orchestrator.sha256],
    ["scripts/backup.ts", evidence.backup.restoreCli.sha256],
    ["scripts/manage-release.mjs", evidence.rollback.manager.sha256],
  ] as const;
  for (const [scriptPath, fingerprint] of expected) {
    try {
      const stat = await lstat(path.join(root, scriptPath));
      if (!stat.isFile() || stat.isSymbolicLink()) return `release_identity_checkout_file_invalid:${scriptPath}`;
      if (digest(await readFile(path.join(root, scriptPath))) !== fingerprint) {
        return `release_identity_checkout_fingerprint_mismatch:${scriptPath}`;
      }
    } catch {
      return `release_identity_checkout_file_unreadable:${scriptPath}`;
    }
  }
  return null;
}

async function verifyReleaseIdentitySources(
  manifest: AcceptanceManifest,
  artifacts: Map<string, { label: string; contents: Buffer }>,
  checkoutRoot: string | undefined,
): Promise<string[]> {
  const reasons: string[] = [];
  const predeploy = artifacts.get("release:identity");
  if (!predeploy) return ["release_identity_gate_blocked:predeploy_missing"];
  const parsed = parseReleaseIdentityEvidence(predeploy.contents, manifest, predeploy.label);
  if (typeof parsed === "string") return [parsed];

  const missing = RELEASE_READBACK_ROUTES.filter((route) => !artifacts.has(route));
  if (missing.length > 0) {
    return [`release_identity_gate_blocked:independent_sources_missing:${missing.join(",")}`];
  }
  const identity = manifest.releaseIdentity;
  const expectedByRoute: Record<(typeof RELEASE_READBACK_ROUTES)[number], Record<string, unknown>> = {
    "release:ci-readback": {
      schemaVersion: 1, kind: "aibrain-release-ci-readback", source: "ci",
      candidateSha: identity.candidateSha, ciSha: identity.ciSha,
    },
    "release:deploy-state": {
      schemaVersion: 1, kind: "aibrain-release-deploy-state-readback", source: "deploy-state",
      ciSha: identity.ciSha, deploySha: identity.deploySha,
      appOciDigest: parsed.identity.appOciDigest, gatewayOciDigest: parsed.identity.gatewayOciDigest,
    },
    "release:runtime-readback": {
      schemaVersion: 1, kind: "aibrain-release-runtime-readback", source: "runtime",
      deploySha: identity.deploySha, runtimeSha: identity.runtimeSha,
      appOciRevision: identity.appOciRevision, gatewayOciRevision: identity.gatewayOciRevision,
    },
    "release:app-oci-inspect": {
      schemaVersion: 1, kind: "aibrain-release-oci-inspect", source: "oci-inspect", component: "app",
      revision: identity.appOciRevision, digest: parsed.identity.appOciDigest,
    },
    "release:gateway-oci-inspect": {
      schemaVersion: 1, kind: "aibrain-release-oci-inspect", source: "oci-inspect", component: "gateway",
      revision: identity.gatewayOciRevision, digest: parsed.identity.gatewayOciDigest,
    },
  };
  for (const route of RELEASE_READBACK_ROUTES) {
    const artifact = artifacts.get(route)!;
    const reason = parseReadback(
      artifact.contents,
      artifact.label,
      expectedByRoute[route],
      route === "release:ci-readback"
        ? ["backendCi", "publish", "deploy", "appOciDigest", "gatewayOciDigest"]
        : [],
    );
    if (reason) reasons.push(reason);
  }
  const ciArtifact = artifacts.get("release:ci-readback")!;
  const pipelineReason = parsePipelineTrace(
    ciArtifact.contents,
    ciArtifact.label,
    identity.candidateSha,
    parsed.identity.appOciDigest,
    parsed.identity.gatewayOciDigest,
  );
  if (pipelineReason) reasons.push(pipelineReason);
  const checkoutReason = await verifyCheckoutFingerprints(manifest, parsed, checkoutRoot);
  if (checkoutReason) reasons.push(checkoutReason);
  return reasons;
}

async function verifyEvidenceFiles(
  manifest: AcceptanceManifest,
  options: { evidenceRoot?: string; checkoutRoot?: string },
): Promise<string[]> {
  const evidenceRoot = options.evidenceRoot;
  if (!evidenceRoot) return ["evidence_root_missing"];
  const reasons: string[] = [];
  const releaseArtifacts = new Map<string, { label: string; contents: Buffer }>();
  let root: string;
  try {
    root = await realpath(evidenceRoot);
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory()) return ["evidence_root_not_directory"];
  } catch {
    return ["evidence_root_unreadable"];
  }

  for (const gate of manifest.gates) {
    for (const evidence of gate.evidence) {
      const label = `${gate.id}:${evidence.artifactPath}`;
      if (path.isAbsolute(evidence.artifactPath) || evidence.artifactPath.split(/[\\/]/u).includes("..")) {
        reasons.push(`evidence_path_unsafe:${label}`);
        continue;
      }
      const candidate = path.resolve(root, evidence.artifactPath);
      if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
        reasons.push(`evidence_path_escape:${label}`);
        continue;
      }
      try {
        const stat = await lstat(candidate);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
          reasons.push(`evidence_not_private_regular_file:${label}`);
          continue;
        }
        if (await realpath(candidate) !== candidate) {
          reasons.push(`evidence_path_redirected:${label}`);
          continue;
        }
        const contents = await readFile(candidate);
        if (digest(contents) !== evidence.sha256) reasons.push(`evidence_digest_mismatch:${label}`);
        else if (gate.id === "release-identity-readiness" && evidence.kind === "release") {
          releaseArtifacts.set(evidence.route, { label, contents });
        }
      } catch {
        reasons.push(`evidence_unreadable:${label}`);
      }
    }
  }
  reasons.push(...await verifyReleaseIdentitySources(manifest, releaseArtifacts, options.checkoutRoot ?? process.cwd()));
  return reasons;
}

export async function evaluateAcceptance(
  input: unknown,
  options: { evidenceRoot?: string; checkoutRoot?: string } = {},
): Promise<AcceptanceEvaluation> {
  const manifestSha256 = digest(canonicalJson(input));
  if (!validator(input)) {
    return {
      verdict: "rejected",
      target: null,
      releaseSha: null,
      manifestSha256,
      reasons: schemaErrors(validator.errors),
      manifest: null,
    };
  }

  const manifest = input as AcceptanceManifest;
  const reasons: string[] = [];
  const actorIds = new Set(manifest.actors.map(({ id }) => id));
  const gateIds = new Set<string>();
  const normalizedTarget = normalizeTarget(manifest.target);

  if (!validTimestamp(manifest.startedAt) || !validTimestamp(manifest.completedAt)
    || Date.parse(manifest.completedAt) < Date.parse(manifest.startedAt)) {
    reasons.push("acceptance_window_invalid");
  }
  if (actorIds.size !== manifest.actors.length) reasons.push("actor_ids_not_unique");

  walkStrings(manifest, (text) => {
    if (secretPatterns.some((pattern) => pattern.test(text))) reasons.push("secret_or_email_material_detected");
  });

  for (const gate of manifest.gates) {
    if (gateIds.has(gate.id)) reasons.push(`duplicate_gate:${gate.id}`);
    gateIds.add(gate.id);
    if (gate.releaseSha !== manifest.releaseSha) reasons.push(`release_sha_mismatch:${gate.id}`);
    if (normalizeTarget(gate.target) !== normalizedTarget) reasons.push(`target_mismatch:${gate.id}`);
    if (Date.parse(gate.completedAt) < Date.parse(gate.startedAt)
      || !inWindow(gate.startedAt, manifest.startedAt, manifest.completedAt)
      || !inWindow(gate.completedAt, manifest.startedAt, manifest.completedAt)) {
      reasons.push(`gate_window_invalid:${gate.id}`);
    }
    if (gate.actorIds.some((actorId) => !actorIds.has(actorId))) reasons.push(`unknown_actor:${gate.id}`);
    if (gate.status === "passed" && gate.failures.length > 0) reasons.push(`passed_gate_has_failures:${gate.id}`);
    for (const evidence of gate.evidence) {
      if (evidence.releaseSha !== manifest.releaseSha) reasons.push(`evidence_release_mismatch:${gate.id}`);
      if (!inWindow(evidence.capturedAt, gate.startedAt, gate.completedAt)) {
        reasons.push(`evidence_window_invalid:${gate.id}:${evidence.artifactPath}`);
      }
    }
  }

  if (manifest.acceptanceKind === "prefilter" || manifest.environment !== "live") {
    return {
      verdict: "prefilter-only",
      target: manifest.target,
      releaseSha: manifest.releaseSha,
      manifestSha256,
      reasons: [...new Set(["local_or_ci_prefilter_is_not_live_acceptance", ...reasons])],
      manifest,
    };
  }

  if (normalizedTarget !== CANONICAL_LIVE_TARGET) reasons.push("canonical_live_target_required");
  if (manifest.actors.length < 2) reasons.push("two_distinct_live_actors_required");
  for (const [source, value] of Object.entries(manifest.releaseIdentity)) {
    if (value !== manifest.releaseSha) reasons.push(`release_identity_mismatch:${source}`);
  }
  for (const required of REQUIRED_LIVE_GATES) {
    const gate = manifest.gates.find(({ id }) => id === required);
    if (!gate) reasons.push(`required_gate_missing:${required}`);
    else {
      if (gate.status !== "passed") reasons.push(`required_gate_not_passed:${required}`);
      if (gate.environment !== "live") reasons.push(`required_gate_not_live:${required}`);
      if (normalizeTarget(gate.target) !== CANONICAL_LIVE_TARGET) reasons.push(`required_gate_wrong_target:${required}`);
    }
  }
  for (const gate of manifest.gates) {
    for (const route of gate.routes) {
      if (/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)\b/iu.test(route)) reasons.push(`local_route_in_live_gate:${gate.id}`);
      if (/^https?:\/\//iu.test(route)) {
        try {
          if (new URL(route).origin !== CANONICAL_LIVE_TARGET) reasons.push(`foreign_route_in_live_gate:${gate.id}`);
        } catch {
          reasons.push(`invalid_route_in_live_gate:${gate.id}`);
        }
      }
    }
    for (const evidence of gate.evidence) {
      if ((evidence.kind === "http" || evidence.kind === "ui")
        && !evidence.route.startsWith("/")
        && !/^[A-Z]+\s+\//u.test(evidence.route)
        && normalizeTarget(evidence.route) !== CANONICAL_LIVE_TARGET) {
        reasons.push(`live_web_evidence_wrong_target:${gate.id}`);
      }
    }
  }
  for (const [gateId, requirement] of Object.entries(GATE_REQUIREMENTS)) {
    const gate = manifest.gates.find(({ id }) => id === gateId);
    if (!gate) continue;
    for (const route of requirement.routes) {
      if (!gate.routes.includes(route)) reasons.push(`required_route_missing:${gateId}:${route}`);
    }
    for (const expected of requirement.evidence) {
      if (!gate.evidence.some((evidence) => evidence.kind === expected.kind && evidence.route === expected.route)) {
        reasons.push(`required_evidence_missing:${gateId}:${expected.kind}:${expected.route}`);
      }
    }
    if (requirement.actorCoverage === "all" && manifest.actors.some(({ id }) => !gate.actorIds.includes(id))) {
      reasons.push(`required_actors_missing:${gateId}`);
    }
  }
  validateConnectorActionGate(
    manifest.gates.find(({ id }) => id === "real-action-approval-readback"),
    manifest,
    reasons,
  );
  const performance = manifest.gates.find(({ id }) => id === "performance-concurrency");
  for (const metric of PERFORMANCE_METRICS) {
    if (typeof performance?.latencyMs?.[metric] !== "number") reasons.push(`performance_metric_missing:${metric}`);
    if (typeof performance?.latencyBudgetMs?.[metric] !== "number") reasons.push(`performance_budget_missing:${metric}`);
    if (typeof performance?.latencyMs?.[metric] === "number"
      && typeof performance?.latencyBudgetMs?.[metric] === "number"
      && performance.latencyMs[metric] > performance.latencyBudgetMs[metric]) {
      reasons.push(`performance_budget_exceeded:${metric}`);
    }
  }
  if (manifest.failures.some(({ severity, status }) => status === "open" && (severity === "critical" || severity === "high"))) {
    reasons.push("open_critical_or_high_failure");
  }
  reasons.push(...await verifyEvidenceFiles(manifest, options));

  const uniqueReasons = [...new Set(reasons)];
  return {
    verdict: uniqueReasons.length === 0 ? "accepted" : "rejected",
    target: manifest.target,
    releaseSha: manifest.releaseSha,
    manifestSha256,
    reasons: uniqueReasons,
    manifest,
  };
}

function markdownCell(value: unknown): string {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderAcceptanceReport(result: AcceptanceEvaluation): string {
  const manifest = result.manifest;
  const lines = [
    "# AiBrain live acceptance report",
    "",
    `- Verdict: **${result.verdict.toUpperCase()}**`,
    `- Target: ${result.target ?? "unavailable"}`,
    `- Release SHA: ${result.releaseSha ?? "unavailable"}`,
    `- Manifest SHA-256: ${result.manifestSha256}`,
  ];
  if (!manifest) {
    lines.push("", "## Contract failures", "", ...result.reasons.map((reason) => `- ${reason}`));
    return `${lines.join("\n")}\n`;
  }
  lines.push(
    `- Window: ${manifest.startedAt} to ${manifest.completedAt}`,
    `- Actors/roles: ${manifest.actors.map(({ id, role }) => `${id} (${role})`).join(", ")}`,
    "",
    "## Gates",
    "",
    "| Gate | Status | Environment | Routes | Latencies ms | Evidence |",
    "|---|---|---|---|---|---|",
  );
  for (const gate of manifest.gates) {
    const latency = gate.latencyMs
      ? Object.entries(gate.latencyMs).map(([key, value]) => `${key}=${value}`).join(", ")
      : "n/a";
    const evidence = gate.evidence.map(({ artifactPath, sha256 }) => `${artifactPath} (${sha256.slice(0, 12)})`).join(", ");
    lines.push(`| ${markdownCell(gate.id)} | ${gate.status} | ${gate.environment} | ${markdownCell(gate.routes.join(", "))} | ${markdownCell(latency)} | ${markdownCell(evidence)} |`);
  }
  lines.push("", "## Acceptance failures", "");
  if (result.reasons.length === 0 && manifest.failures.length === 0) lines.push("- None.");
  else {
    lines.push(...result.reasons.map((reason) => `- Gate: ${reason}`));
    lines.push(...manifest.gates.flatMap((gate) => gate.failures.map((failure) => `- ${gate.id}: ${failure}`)));
    lines.push(...manifest.failures.map((failure) => `- ${failure.id} [${failure.severity}/${failure.status}]: ${failure.summary}`));
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const manifestPath = value("--manifest");
  const evidenceRoot = value("--evidence-root");
  const checkoutRoot = value("--checkout-root");
  const format = value("--format") ?? "markdown";
  if (!manifestPath || !["markdown", "json"].includes(format)) {
    process.stderr.write("Usage: npm run acceptance:verify -- --manifest <json> --evidence-root <dir> [--checkout-root <verified-candidate-dir>] [--format markdown|json]\n");
    process.exitCode = 64;
    return;
  }
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.nlink !== 1) {
    throw new Error("Acceptance manifest must be a private regular file, not a link.");
  }
  const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  const result = await evaluateAcceptance(parsed, { evidenceRoot, checkoutRoot });
  process.stdout.write(format === "json" ? `${JSON.stringify(result, null, 2)}\n` : renderAcceptanceReport(result));
  process.exitCode = result.verdict === "accepted" ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
