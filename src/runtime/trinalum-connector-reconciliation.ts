import "server-only";
import { nativeAttioActors } from "./trinalum-native-disposition";
import { createHash } from "node:crypto";
import { request } from "node:http";
import path from "node:path";
import { readRegularFileWithin } from "@/security/safe-file";
import { parseConnectorReconciliationProof, type ConnectorReconciliationProof, type FileApprovalStore } from "./approval-store";
import { TrinalumChatActions, type ChatAction } from "./trinalum-chat-actions";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

type Bridge = { installationId: string; url: string; socketPath?: string; users: Record<string, { token: string; status: string }> };

/** Streaming status only. The legacy buffered broker transport must not consume
 * a held proof: it would wait for EOF while the native locks wait for us. */
export async function withHeldNativeProof<T>(config: Bridge, token: string, body: unknown,
  apply: (proof: ConnectorReconciliationProof, assertHeld: () => void) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const endpoint = new URL(config.url);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/read" ||
      config.socketPath !== undefined && config.socketPath !== "/run/trinalum-broker/broker.sock") throw Error("RECONCILIATION_BROKER_INVALID");
  return new Promise<T>((resolve, reject) => {
    let alive = false, proofStarted = false, ended = false;
    const req = request({ ...(config.socketPath ? { socketPath: config.socketPath } : { hostname: endpoint.hostname, port: endpoint.port }),
      path: "/action-status", method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }, res => {
      if (res.statusCode !== 200 || !String(res.headers["content-type"]).startsWith("application/x-ndjson")) { req.destroy(); reject(Error("RECONCILIATION_NATIVE_UNAVAILABLE")); return; }
      alive = true;
      let pending = Buffer.alloc(0);
      const fail = () => { alive = false; if (!ended) reject(Error("RECONCILIATION_NATIVE_LOCK_LOST")); };
      res.on("end", fail); res.on("close", fail); res.on("error", fail);
      res.on("data", (chunk: Buffer) => {
        if (proofStarted) { if (chunk.toString().trim()) { alive = false; req.destroy(); } return; }
        pending = Buffer.concat([pending, chunk]);
        if (pending.length > 16_384) { alive = false; req.destroy(); reject(Error("RECONCILIATION_NATIVE_INVALID")); return; }
        const newline = pending.indexOf(10);
        if (newline < 0) return;
        proofStarted = true;
        void (async () => {
          if (pending.subarray(newline + 1).toString().trim()) throw Error("RECONCILIATION_NATIVE_INVALID");
          const proof = parseConnectorReconciliationProof(JSON.parse(pending.subarray(0, newline).toString("utf8")));
          return apply(proof, () => { if (!alive || signal?.aborted || Date.parse(proof.expiresAt) <= Date.now()) throw Error("RECONCILIATION_NATIVE_LOCK_LOST"); });
        })().then(value => { ended = true; resolve(value); }, error => { ended = true; reject(error); }).finally(() => { alive = false; req.destroy(); });
      });
    });
    const deadline = setTimeout(() => { alive = false; req.destroy(Error("RECONCILIATION_NATIVE_TIMEOUT")); }, 30_000);
    deadline.unref?.();
    const abort = () => { alive = false; req.destroy(Error("RECONCILIATION_CANCELLED")); };
    signal?.addEventListener("abort", abort, { once: true });
    req.on("error", reject);
    req.on("close", () => { clearTimeout(deadline); signal?.removeEventListener("abort", abort); });
    if (signal?.aborted) abort(); else req.end(JSON.stringify(body));
  });
}

/** Operator API only: no tool registration, provider write or automatic execution. */
export async function reconcileTrinalumConnectorDisposition(input: {
  store: FileApprovalStore; actionId: string; runtimeThreadId: string; configPath: string;
  expectedChatActionSha256: string; expectedRecordSha256: string; operatorArtifactHash: string;
  proofCategory: ConnectorReconciliationProof["proofCategory"]; signal?: AbortSignal;
  verifyCurrentGrant: (action: ChatAction) => Promise<{ email: string; permissionFingerprint: string }>;
}) {
  if (input.store.installationId !== "trinalum-production" || !path.isAbsolute(input.configPath) ||
      !/^[a-f0-9]{64}$/.test(input.expectedChatActionSha256)) throw Error("RECONCILIATION_IDENTITY_INVALID");
  const actionStore = new TrinalumChatActions(input.store.userRoot, { installationId: input.store.installationId, userId: input.store.userId, threadId: input.runtimeThreadId });
  const relative = path.join("trinalum-chat-actions", hash(input.runtimeThreadId), `${input.actionId}.json`);
  const action = await actionStore.read(input.actionId);
  if (!action || action.operation !== "attio_action") throw Error("RECONCILIATION_ACTION_INVALID");
  const check = async () => {
    if (input.signal?.aborted || Date.parse(action.expiresAt) <= Date.now() ||
        hash(await readRegularFileWithin(input.store.userRoot, relative, 64 * 1024 * 1024)) !== input.expectedChatActionSha256) throw Error("RECONCILIATION_ACTION_CHANGED_OR_EXPIRED");
    const grant = await input.verifyCurrentGrant(action);
    const requestedBy = nativeAttioActors[grant.email.trim().toLowerCase()];
    if (!requestedBy || grant.permissionFingerprint !== action.permissionFingerprint) throw Error("RECONCILIATION_GRANT_CHANGED");
    const config = JSON.parse((await readRegularFileWithin(path.dirname(input.configPath), path.basename(input.configPath), 1024 * 1024)).toString("utf8")) as Bridge;
    const binding = config.users?.[input.store.userId];
    if (config.installationId !== input.store.installationId || binding?.status !== "active" || typeof binding.token !== "string" || binding.token.length < 32 || hash(binding.token) !== action.bindingHash) throw Error("RECONCILIATION_BINDING_CHANGED");
    return { config, binding, requestedBy };
  };
  const { config, binding, requestedBy } = await check();
  const requestHash = hash(stable({ id: action.id, type: action.input.type, requestedBy, request: action.input.request }));
  const current = (await input.store.inspectConnectorApprovalForReconciliation(action.locator))?.record;
  if (!current || current.authorizationFingerprint !== action.fingerprint || current.expiresAt !== action.expiresAt) throw Error("RECONCILIATION_APPROVAL_CHANGED");
  return input.store.reconcileConnectorDisposition({ reconciliationVersion: 1, proofCategory: input.proofCategory,
    receipt: { schemaVersion: 1, ...action.locator, authorizationFingerprint: current.authorizationFingerprint, receiptId: current.receiptId, expiresAt: current.expiresAt },
    expectedRecordSha256: input.expectedRecordSha256, operatorArtifactHash: input.operatorArtifactHash,
    action: { actionId: action.id, requestedBy, requestHash },
    withProof: async apply => withHeldNativeProof(config, binding.token,
      { operation: "attio_action", input: action.input, actionId: action.id, phase: input.proofCategory === "no-dispatch" ? "status" : "rejection-status" },
      async (proof, held) => apply(proof, async () => { held(); const fresh = await check(); if (fresh.requestedBy !== requestedBy || fresh.binding.token !== binding.token) throw Error("RECONCILIATION_BINDING_CHANGED"); held(); }), input.signal),
  });
}
