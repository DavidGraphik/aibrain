import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CANONICAL_LIVE_TARGET,
  REQUIRED_LIVE_GATES,
  evaluateAcceptance,
  renderAcceptanceReport,
  type ConnectorAction,
  type AcceptanceEvidence,
  type AcceptanceManifest,
} from "../../scripts/verify-live-acceptance";
import { createPredeployReleaseEvidence } from "../../scripts/create-predeploy-release-evidence";
import { collectReleaseReadbacks, type ReleaseReadbackRoute } from "../../scripts/collect-release-readbacks";

const roots: string[] = [];
const releaseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8" }).trim();
const startedAt = "2026-08-28T10:00:00.000Z";
const completedAt = "2026-08-28T10:10:00.000Z";
const tenantId = "arnall";
const connectorAction: ConnectorAction = {
  connectorId: "crm",
  provider: "attio",
  tenantId,
  actorId: "david",
  credentialReference: "oauthref-arnall-david",
  authorization: "oauth",
  providerLive: true,
  operationId: "operation-create-note-001",
  operationType: "create-note",
  approvalId: "approval-create-note-001",
  executionId: "execution-create-note-001",
  executionCount: 1,
  providerReadbackId: "provider-note-001",
};
const gateRoutes: Record<string, string[]> = {
  "release-identity-readiness": ["GET /api/health/live", "GET /api/health/ready"],
  "threat-model-contracts": ["contract:live-acceptance"],
  "functional-desktop-mobile": ["/"],
  accessibility: ["/"],
  visual: ["/"],
  "performance-concurrency": ["POST /api/chat"],
  "failure-restart-reconnect": ["POST /api/chat", "POST /api/runtime/turns/control"],
  "two-user-isolation": ["GET /api/workbench"],
  "real-turn": ["POST /api/chat", "GET /api/runtime/status"],
  "files-search-library-memory": ["POST /api/threads/{threadId}/documents", "GET /api/library", "GET /api/search", "GET /api/memory"],
  "real-action-approval-readback": ["POST /api/runtime/approvals", "connector:operation", "connector:provider-readback"],
  "logs-backup-rollback": ["operations:logs", "backup:verify", "backup:restore", "release:rollback"],
};
const gateEvidence: Record<string, Array<Pick<AcceptanceEvidence, "kind" | "route">>> = {
  "release-identity-readiness": [
    { kind: "release", route: "release:identity" },
    { kind: "release", route: "release:ci-readback" },
    { kind: "release", route: "release:deploy-state" },
    { kind: "release", route: "release:runtime-readback" },
    { kind: "release", route: "release:app-oci-inspect" },
    { kind: "release", route: "release:gateway-oci-inspect" },
    { kind: "http", route: "GET /api/health/live" },
    { kind: "http", route: "GET /api/health/ready" },
  ],
  "threat-model-contracts": [{ kind: "contract", route: "contract:live-acceptance" }],
  "functional-desktop-mobile": [{ kind: "ui", route: "/" }],
  accessibility: [{ kind: "accessibility", route: "/" }],
  visual: [{ kind: "visual", route: "/" }],
  "performance-concurrency": [{ kind: "metric", route: "POST /api/chat" }],
  "failure-restart-reconnect": [
    { kind: "restart", route: "POST /api/runtime/turns/control" },
    { kind: "reconnect", route: "POST /api/chat" },
  ],
  "two-user-isolation": [{ kind: "isolation", route: "GET /api/workbench" }],
  "real-turn": [
    { kind: "turn", route: "POST /api/chat" },
    { kind: "readback", route: "GET /api/runtime/status" },
  ],
  "files-search-library-memory": [
    { kind: "file", route: "POST /api/threads/{threadId}/documents" },
    { kind: "library", route: "GET /api/library" },
    { kind: "search", route: "GET /api/search" },
    { kind: "memory", route: "GET /api/memory" },
  ],
  "real-action-approval-readback": [
    { kind: "connector-oauth", route: "connector:oauth" },
    { kind: "connector-approval", route: "POST /api/runtime/approvals" },
    { kind: "connector-execution", route: "connector:operation" },
    { kind: "connector-readback", route: "connector:provider-readback" },
  ],
  "logs-backup-rollback": [
    { kind: "log", route: "operations:logs" },
    { kind: "backup", route: "backup:verify" },
    { kind: "restore", route: "backup:restore" },
    { kind: "rollback", route: "release:rollback" },
  ],
};

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function artifactPath(gateId: string, kind: string, route: string): string {
  return gateId === "release-identity-readiness" && kind === "release"
    ? `${gateId}-${route.replaceAll(":", "-")}.json`
    : `${gateId}-${kind}.json`;
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-live-acceptance-"));
  roots.push(root);
  const evidenceRoot = path.join(root, "evidence");
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  const appImage = `registry.example.test/aibrain@sha256:${"b".repeat(64)}`;
  const gatewayImage = `registry.example.test/aibrain-gateway@sha256:${"c".repeat(64)}`;
  const pipelineSource = path.join(root, "release-pipeline.json");
  const releaseState = path.join(root, "release-state.json");
  await writeFile(pipelineSource, `${JSON.stringify({
    schemaVersion: 2,
    headSha: releaseSha,
    backendCi: { workflow: "Backend CI", conclusion: "success", headSha: releaseSha, runId: "33165012869" },
    publish: { workflow: "Publish GHCR images", conclusion: "success", headSha: releaseSha, runId: "33165012870" },
    deploy: { workflow: "Deploy Arnall", headSha: releaseSha, runId: "33165012871" },
    images: { appDigest: appImage.split("@")[1], gatewayDigest: gatewayImage.split("@")[1] },
  })}\n`, { mode: 0o600 });
  await writeFile(releaseState, `${JSON.stringify({ schemaVersion: 3, current: { revision: releaseSha, image: appImage, egressImage: gatewayImage } })}\n`, { mode: 0o600 });
  const releaseArtifacts = new Map((await collectReleaseReadbacks({
    candidateSha: releaseSha,
    pipelineSourcePath: pipelineSource,
    releaseStatePath: releaseState,
    appContainer: "a".repeat(12),
    gatewayContainer: "b".repeat(12),
    capturedAt: "2026-08-28T10:05:00.000Z",
    command: {
      run: async (args) => {
        const target = args.at(-1);
        const image = target === "a".repeat(12) || target === appImage ? appImage : gatewayImage;
        if (args.includes("{{.Config.Image}}")) return image;
        if (args.includes("{{json .Config.Env}}")) return JSON.stringify([
          `AIBRAIN_REVISION=${releaseSha}`,
          "NODE_ENV=production",
        ]);
        if (args.some((arg) => arg.includes("org.opencontainers.image.revision"))) return releaseSha;
        if (args.includes("{{json .RepoDigests}}")) return JSON.stringify([image]);
        throw new Error(`Unexpected Docker command: ${args.join(" ")}`);
      },
    },
  })).map((artifact) => [artifact.route, artifact.value]));
  const artifacts = new Map<string, string>();
  for (const gateId of REQUIRED_LIVE_GATES) {
    for (const { kind, route } of gateEvidence[gateId]) {
      const artifact = artifactPath(gateId, kind, route);
      const contents = gateId === "release-identity-readiness" && kind === "release"
        ? route === "release:identity" ? `${JSON.stringify(await createPredeployReleaseEvidence({
          candidateSha: releaseSha,
          ciSha: releaseSha,
          deploySha: releaseSha,
          runtimeSha: releaseSha,
          appOciRevision: releaseSha,
          gatewayOciRevision: releaseSha,
          appOciDigest: `sha256:${"b".repeat(64)}`,
          gatewayOciDigest: `sha256:${"c".repeat(64)}`,
        }, process.cwd()))}\n` : `${JSON.stringify(releaseArtifacts.get(route as ReleaseReadbackRoute))}\n`
        : `${JSON.stringify({ gateId, kind, route, target: CANONICAL_LIVE_TARGET, releaseSha })}\n`;
      await writeFile(path.join(evidenceRoot, artifact), contents, { mode: 0o600 });
      artifacts.set(artifact, sha256(contents));
    }
  }
  return { evidenceRoot, artifacts };
}

function manifest(artifacts: Map<string, string>): AcceptanceManifest {
  return {
    schemaVersion: 1,
    acceptanceKind: "live",
    environment: "live",
    target: CANONICAL_LIVE_TARGET,
    releaseSha,
    tenantId,
    releaseIdentity: {
      candidateSha: releaseSha,
      ciSha: releaseSha,
      deploySha: releaseSha,
      runtimeSha: releaseSha,
      appOciRevision: releaseSha,
      gatewayOciRevision: releaseSha,
    },
    startedAt,
    completedAt,
    actors: [
      { id: "david", role: "owner" },
      { id: "arnau", role: "member" },
    ],
    gates: REQUIRED_LIVE_GATES.map((id) => ({
      id,
      status: "passed",
      environment: "live",
      target: CANONICAL_LIVE_TARGET,
      releaseSha,
      startedAt: "2026-08-28T10:01:00.000Z",
      completedAt: "2026-08-28T10:09:00.000Z",
      actorIds: ["two-user-isolation", "real-turn", "files-search-library-memory"].includes(id)
        ? ["david", "arnau"] : ["david"],
      routes: gateRoutes[id],
      ...(id === "performance-concurrency" ? {
        latencyMs: {
          navigationP95Ms: 210,
          inputP95Ms: 30,
          ttftP95Ms: 900,
          streamGapP95Ms: 120,
          turnTotalP95Ms: 2_400,
          reconnectP95Ms: 700,
          toolReadbackP95Ms: 1_200,
        },
      } : {}),
      ...(id === "performance-concurrency" ? {
        latencyBudgetMs: {
          navigationP95Ms: 400,
          inputP95Ms: 100,
          ttftP95Ms: 1_500,
          streamGapP95Ms: 250,
          turnTotalP95Ms: 3_000,
          reconnectP95Ms: 1_000,
          toolReadbackP95Ms: 1_500,
        },
      } : {}),
      ...(id === "real-action-approval-readback" ? { connectorAction } : {}),
      evidence: gateEvidence[id].map(({ kind, route }) => ({
        kind,
        artifactPath: artifactPath(id, kind, route),
        sha256: artifacts.get(artifactPath(id, kind, route))!,
        capturedAt: "2026-08-28T10:05:00.000Z",
        route,
        releaseSha,
        ...(id === "real-action-approval-readback" ? {
          connectorCorrelation: {
            connectorId: connectorAction.connectorId,
            provider: connectorAction.provider,
            tenantId: connectorAction.tenantId,
            actorId: connectorAction.actorId,
            credentialReference: connectorAction.credentialReference,
            operationId: connectorAction.operationId,
            approvalId: connectorAction.approvalId,
            executionId: connectorAction.executionId,
            providerReadbackId: connectorAction.providerReadbackId,
          },
        } : {}),
      })),
      failures: [],
    })),
    failures: [],
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("live acceptance evidence contract", () => {
  it("accepts separate CI, deploy, runtime and OCI source fixtures tied to the verified checkout", async () => {
    const files = await fixture();
    const result = await evaluateAcceptance(manifest(files.artifacts), { evidenceRoot: files.evidenceRoot });
    expect(result.verdict).toBe("accepted");
    expect(result.reasons).toEqual([]);
    expect(renderAcceptanceReport(result)).toContain("**ACCEPTED**");
    expect(renderAcceptanceReport(result)).toContain("david (owner), arnau (member)");
    expect(renderAcceptanceReport(result)).toContain("ttftP95Ms=900");
  });

  it("classifies localhost and CI evidence as prefilter-only even when every gate passes", async () => {
    const files = await fixture();
    const local = manifest(files.artifacts);
    local.acceptanceKind = "prefilter";
    local.environment = "ci";
    local.target = "http://127.0.0.1:3100";
    for (const gate of local.gates) {
      gate.environment = "ci";
      gate.target = local.target;
    }
    const result = await evaluateAcceptance(local, { evidenceRoot: files.evidenceRoot });
    expect(result.verdict).toBe("prefilter-only");
    expect(result.reasons).toContain("local_or_ci_prefilter_is_not_live_acceptance");
  });

  it("rejects missing gates, wrong live target, release drift, incomplete metrics and open high failures", async () => {
    const files = await fixture();
    const incomplete = manifest(files.artifacts);
    incomplete.target = "https://preview.example-platform.invalid";
    incomplete.gates = incomplete.gates.filter(({ id }) => id !== "real-turn");
    incomplete.gates[0].releaseSha = "b".repeat(40);
    incomplete.gates.find(({ id }) => id === "performance-concurrency")!.latencyMs = { ttftP95Ms: 900 };
    incomplete.failures.push({ id: "isolation-gap", severity: "high", status: "open", summary: "Live isolation is not proved." });
    const result = await evaluateAcceptance(incomplete, { evidenceRoot: files.evidenceRoot });
    expect(result.verdict).toBe("rejected");
    expect(result.reasons).toEqual(expect.arrayContaining([
      "canonical_live_target_required",
      "required_gate_missing:real-turn",
      "release_sha_mismatch:release-identity-readiness",
      "performance_metric_missing:navigationP95Ms",
      "open_critical_or_high_failure",
    ]));
  });

  it("rejects generic gate evidence, incomplete actor coverage, release identity drift and a missed latency budget", async () => {
    const files = await fixture();
    const bypass = manifest(files.artifacts);
    bypass.releaseIdentity.runtimeSha = "b".repeat(40);
    const turn = bypass.gates.find(({ id }) => id === "real-turn")!;
    turn.actorIds = ["david"];
    turn.routes = ["acceptance:real-turn"];
    turn.evidence = turn.evidence.filter(({ kind }) => kind === "turn");
    const operations = bypass.gates.find(({ id }) => id === "logs-backup-rollback")!;
    operations.evidence = operations.evidence.filter(({ kind }) => kind !== "restore");
    bypass.gates.find(({ id }) => id === "performance-concurrency")!.latencyBudgetMs!.ttftP95Ms = 100;

    const result = await evaluateAcceptance(bypass, { evidenceRoot: files.evidenceRoot });
    expect(result.verdict).toBe("rejected");
    expect(result.reasons).toEqual(expect.arrayContaining([
      "release_identity_mismatch:runtimeSha",
      "required_actors_missing:real-turn",
      "required_route_missing:real-turn:POST /api/chat",
      "required_evidence_missing:real-turn:readback:GET /api/runtime/status",
      "required_evidence_missing:logs-backup-rollback:restore:backup:restore",
      "performance_budget_exceeded:ttftP95Ms",
    ]));
  });

  it("rejects connector health or capability evidence as an action", async () => {
    const files = await fixture();
    const healthOnly = manifest(files.artifacts);
    const action = healthOnly.gates.find(({ id }) => id === "real-action-approval-readback")!;
    action.routes = ["GET /api/runtime/status"];
    action.evidence = [{
      kind: "http",
      artifactPath: "real-action-approval-readback-connector-oauth.json",
      sha256: files.artifacts.get("real-action-approval-readback-connector-oauth.json")!,
      capturedAt: "2026-08-28T10:05:00.000Z",
      route: "GET /api/runtime/status",
      releaseSha,
    }];
    const result = await evaluateAcceptance(healthOnly, { evidenceRoot: files.evidenceRoot });
    expect(result.verdict).toBe("rejected");
    expect(result.reasons).toEqual(expect.arrayContaining([
      "required_route_missing:real-action-approval-readback:POST /api/runtime/approvals",
      "connector_evidence_missing:connector-oauth",
      "connector_evidence_missing:connector-execution",
      "connector_evidence_missing:connector-readback",
    ]));
  });

  it("rejects a generic audit and a connector action without provider readback", async () => {
    const files = await fixture();
    const genericAudit = manifest(files.artifacts);
    const action = genericAudit.gates.find(({ id }) => id === "real-action-approval-readback")!;
    action.evidence = [{
      kind: "audit",
      artifactPath: "real-action-approval-readback-connector-oauth.json",
      sha256: files.artifacts.get("real-action-approval-readback-connector-oauth.json")!,
      capturedAt: "2026-08-28T10:05:00.000Z",
      route: "audit:connector",
      releaseSha,
    }];
    let result = await evaluateAcceptance(genericAudit, { evidenceRoot: files.evidenceRoot });
    expect(result.verdict).toBe("rejected");
    expect(result.reasons).toEqual(expect.arrayContaining([
      "connector_generic_audit_rejected",
      "connector_evidence_missing:connector-readback",
    ]));

    const noReadback = manifest(files.artifacts);
    const liveAction = noReadback.gates.find(({ id }) => id === "real-action-approval-readback")!;
    liveAction.evidence = liveAction.evidence.filter(({ kind }) => kind !== "connector-readback");
    result = await evaluateAcceptance(noReadback, { evidenceRoot: files.evidenceRoot });
    expect(result.verdict).toBe("rejected");
    expect(result.reasons).toContain("connector_evidence_missing:connector-readback");
  });

  it("fails explicitly when OAuth, credential reference or a live provider is absent", async () => {
    const files = await fixture();
    const unavailable = manifest(files.artifacts);
    const action = unavailable.gates.find(({ id }) => id === "real-action-approval-readback")!.connectorAction!;
    action.authorization = "none";
    action.credentialReference = "";
    action.providerLive = false;
    const result = await evaluateAcceptance(unavailable, { evidenceRoot: files.evidenceRoot });
    expect(result.verdict).toBe("rejected");
    expect(result.reasons).toEqual(expect.arrayContaining([
      "connector_oauth_missing",
      "connector_credential_missing",
      "connector_provider_not_live",
      "connector_correlation_mismatch:connector-oauth:credentialReference",
    ]));
  });

  it("rejects a generic release artifact and incomplete backup or rollback preparation", async () => {
    const files = await fixture();
    const artifactPath = "release-identity-readiness-release-identity.json";
    const generic = `${JSON.stringify({ gateId: "release-identity-readiness", kind: "release", releaseSha })}\n`;
    await writeFile(path.join(files.evidenceRoot, artifactPath), generic, { mode: 0o600 });
    files.artifacts.set(artifactPath, sha256(generic));
    let result = await evaluateAcceptance(manifest(files.artifacts), { evidenceRoot: files.evidenceRoot });
    expect(result.verdict).toBe("rejected");
    expect(result.reasons).toContain(`release_identity_evidence_invalid:release-identity-readiness:${artifactPath}`);

    const evidence = JSON.parse(JSON.stringify(await createPredeployReleaseEvidence({
      candidateSha: releaseSha,
      ciSha: releaseSha,
      deploySha: releaseSha,
      runtimeSha: releaseSha,
      appOciRevision: releaseSha,
      gatewayOciRevision: releaseSha,
      appOciDigest: `sha256:${"b".repeat(64)}`,
      gatewayOciDigest: `sha256:${"c".repeat(64)}`,
    }, process.cwd()))) as { backup: { verificationRequired: boolean } };
    evidence.backup.verificationRequired = false;
    const incomplete = `${JSON.stringify(evidence)}\n`;
    await writeFile(path.join(files.evidenceRoot, artifactPath), incomplete, { mode: 0o600 });
    files.artifacts.set(artifactPath, sha256(incomplete));
    result = await evaluateAcceptance(manifest(files.artifacts), { evidenceRoot: files.evidenceRoot });
    expect(result.reasons).toContain(`release_identity_evidence_mismatch:release-identity-readiness:${artifactPath}`);
  });

  it("blocks equal self-written SHAs until every independent release source is present", async () => {
    const files = await fixture();
    const selfAsserted = manifest(files.artifacts);
    const releaseGate = selfAsserted.gates.find(({ id }) => id === "release-identity-readiness")!;
    releaseGate.evidence = releaseGate.evidence.filter(({ route }) => route === "release:identity" || route.startsWith("GET /api/health/"));
    const result = await evaluateAcceptance(selfAsserted, { evidenceRoot: files.evidenceRoot });
    expect(result.verdict).toBe("rejected");
    expect(result.reasons).toContain("release_identity_gate_blocked:independent_sources_missing:release:ci-readback,release:deploy-state,release:runtime-readback,release:app-oci-inspect,release:gateway-oci-inspect");
  });

  it("rejects an arbitrary predeploy fingerprint even when its SHA syntax is valid", async () => {
    const files = await fixture();
    const artifact = "release-identity-readiness-release-identity.json";
    const evidence = await createPredeployReleaseEvidence({
      candidateSha: releaseSha,
      ciSha: releaseSha,
      deploySha: releaseSha,
      runtimeSha: releaseSha,
      appOciRevision: releaseSha,
      gatewayOciRevision: releaseSha,
      appOciDigest: `sha256:${"b".repeat(64)}`,
      gatewayOciDigest: `sha256:${"c".repeat(64)}`,
    }, process.cwd());
    evidence.backup.orchestrator.sha256 = "d".repeat(64);
    const contents = `${JSON.stringify(evidence)}\n`;
    await writeFile(path.join(files.evidenceRoot, artifact), contents, { mode: 0o600 });
    files.artifacts.set(artifact, sha256(contents));
    const result = await evaluateAcceptance(manifest(files.artifacts), { evidenceRoot: files.evidenceRoot });
    expect(result.verdict).toBe("rejected");
    expect(result.reasons).toContain("release_identity_checkout_fingerprint_mismatch:scripts/orchestrate-backup.mjs");
  });

  it("rejects absent, modified, symlinked and hard-linked evidence", async () => {
    const files = await fixture();
    const changed = manifest(files.artifacts);
    await writeFile(path.join(files.evidenceRoot, "real-turn-turn.json"), "tampered\n", { mode: 0o600 });
    await rm(path.join(files.evidenceRoot, "visual-visual.json"));
    await symlink(path.join(files.evidenceRoot, "accessibility-accessibility.json"), path.join(files.evidenceRoot, "visual-visual.json"));
    await link(path.join(files.evidenceRoot, "threat-model-contracts-contract.json"), path.join(files.evidenceRoot, "duplicate-evidence.json"));
    const result = await evaluateAcceptance(changed, { evidenceRoot: files.evidenceRoot });
    expect(result.verdict).toBe("rejected");
    expect(result.reasons.some((reason) => reason.startsWith("evidence_digest_mismatch:real-turn"))).toBe(true);
    expect(result.reasons.some((reason) => reason.startsWith("evidence_not_private_regular_file:visual"))).toBe(true);
    expect(result.reasons.some((reason) => reason.startsWith("evidence_not_private_regular_file:threat-model-contracts"))).toBe(true);
  });

  it("rejects secret-shaped content and unknown manifest fields", async () => {
    const files = await fixture();
    const leaked = manifest(files.artifacts) as AcceptanceManifest & { token?: string };
    leaked.failures.push({ id: "leak", severity: "low", status: "resolved", summary: "Authorization: Bearer abcdefghijklmnop" });
    let result = await evaluateAcceptance(leaked, { evidenceRoot: files.evidenceRoot });
    expect(result.verdict).toBe("rejected");
    expect(result.reasons).toContain("secret_or_email_material_detected");

    leaked.token = "must-not-be-accepted";
    result = await evaluateAcceptance(leaked, { evidenceRoot: files.evidenceRoot });
    expect(result.verdict).toBe("rejected");
    expect(result.reasons.some((reason) => reason.includes("must NOT have additional properties"))).toBe(true);
  });
});
