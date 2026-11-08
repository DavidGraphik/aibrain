import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import type { PublicationOriginal } from "@/documents/publication-contract";
import { PUBLICATION_UUID } from "@/documents/publication-contract";
import { readRegularFileWithin } from "@/security/safe-file";
import { StorageError } from "@/storage/errors";
import { g03PublicationTarget } from "./publication-target";

export type RemoteWriteBinding = {
  path: string; operationId: string; actorId: string; projectId: string;
  writeOperation: "create" | "replace"; sha256: string; expectedSha256: string | null;
};
export type RemoteWriteReceipt = {
  status: "committed" | "already_committed" | "rejected" | "restored" | "not_found";
  operationId: string; sha256: string; previousSha256: string | null;
  backupId: string | null; checkedAt: string;
};
export interface RemotePublicationTransport {
  snapshot(target: string): Promise<PublicationOriginal>;
  publish(binding: RemoteWriteBinding, data: Buffer): Promise<RemoteWriteReceipt>;
  receipt(binding: RemoteWriteBinding): Promise<RemoteWriteReceipt>;
}

const MAX_BYTES = 16 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function fail(code = "PUBLICATION_REMOTE_UNAVAILABLE"): never {
  throw new StorageError(code, "No confirmed Windows publication result is available.");
}

/** Instantiate only in the trusted application server after session and policy checks. */
export class G03PublicationClient implements RemotePublicationTransport {
  constructor(private readonly options: {
    installationId: string; socketDirectory: string; ownerUid?: number; timeoutMs?: number;
  }) {
    if (!/^g03(?:-[a-z0-9-]+)?$/.test(options.installationId) ||
        !path.isAbsolute(options.socketDirectory) || options.socketDirectory === "/") fail("PUBLICATION_SCOPE_MISMATCH");
  }

  private async request(operation: string, input: object) {
    const directory = this.options.socketDirectory;
    const uid = this.options.ownerUid ?? 0;
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o022) ||
        await realpath(directory) !== directory) fail("PUBLICATION_REMOTE_UNSAFE");
    const descriptorInfo = await lstat(path.join(directory, "g03.json"));
    if (descriptorInfo.uid !== uid || (descriptorInfo.mode & 0o022)) fail("PUBLICATION_REMOTE_UNSAFE");
    const descriptor: unknown = JSON.parse((await readRegularFileWithin(directory, "g03.json", 4096)).toString("utf8"));
    if (!record(descriptor) || descriptor.schemaVersion !== 1 || descriptor.installationId !== this.options.installationId ||
        descriptor.connectionId !== "g03" || descriptor.scope !== "company" || descriptor.mode !== "read-only") fail("PUBLICATION_SCOPE_MISMATCH");
    const socketPath = path.join(directory, "g03-publish.sock");
    const socketInfo = await lstat(socketPath);
    if (!socketInfo.isSocket() || socketInfo.uid !== uid || (socketInfo.mode & 0o007)) fail("PUBLICATION_REMOTE_UNSAFE");
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const requestId = randomUUID();
      const socket = createConnection({ path: socketPath });
      let received = Buffer.alloc(0); let settled = false;
      const finish = (error?: Error, result?: Record<string, unknown>) => {
        if (settled) return;
        settled = true; clearTimeout(timer); socket.destroy();
        if (error) reject(error); else resolve(result!);
      };
      const unknown = () => finish(new StorageError("PUBLICATION_REMOTE_UNCERTAIN", "Consult the same operation receipt; do not repeat the write."));
      const timer = setTimeout(unknown, this.options.timeoutMs ?? 65_000);
      socket.on("error", unknown); socket.on("end", unknown);
      socket.on("connect", () => socket.write(JSON.stringify({ schemaVersion: 1,
        installationId: this.options.installationId, connectionId: "g03", requestId, operation, input }) + "\n"));
      socket.on("data", (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        if (received.length > 8192) return unknown();
        const end = received.indexOf(10);
        if (end < 0) return;
        try {
          const value: unknown = JSON.parse(received.subarray(0, end).toString("utf8"));
          if (!record(value) || value.requestId !== requestId || value.installationId !== this.options.installationId ||
              value.connectionId !== "g03") return unknown();
          if (value.available !== true) {
            // Even a safe failure is not an instruction to retry with a new ID.
            const code = value.error === "WRITE_CONFLICT" ? "PUBLICATION_ORIGINAL_CONFLICT" : "PUBLICATION_REMOTE_UNCERTAIN";
            return finish(new StorageError(code, "Windows did not confirm the requested operation."));
          }
          if (value.path !== (input as { path: string }).path || typeof value.checkedAt !== "string" ||
              !Number.isFinite(Date.parse(value.checkedAt)) || Math.abs(Date.now() - Date.parse(value.checkedAt)) > 120_000 ||
              value.lookupMode !== "live") return unknown();
          finish(undefined, value);
        } catch { unknown(); }
      });
    });
  }

  async snapshot(target: string): Promise<PublicationOriginal> {
    const value = await this.request("snapshot", { path: g03PublicationTarget(target) });
    if (value.sourceChecked !== true || typeof value.exists !== "boolean") fail();
    let metadataNow = Date.now();
    if (value.sourceClock !== undefined) {
      // Only our private, tenant-bound relay may supply this v2 provenance.
      // request() still requires a fresh HOST checkedAt and exact request ID.
      // Original Windows mtimes are metadata, never a freshness/authentication proof.
      const clock = value.sourceClock;
      if (!record(clock) || Object.keys(clock).sort().join(",") !== "basis,checkedAt,freshness" ||
          clock.basis !== "windows-wall-clock" || clock.freshness !== "authenticated-monotonic-job-v2" ||
          typeof clock.checkedAt !== "string" || !Number.isFinite(Date.parse(clock.checkedAt)) ||
          Date.parse(clock.checkedAt) < 0 || Date.parse(clock.checkedAt) > 253402300799000) fail();
      metadataNow = Date.parse(clock.checkedAt);
    }
    if (value.exists === false) {
      if (value.size !== null || value.sha256 !== null || value.modifiedAt !== null) fail();
      return { exists: false, size: null, sha256: null, mtimeMs: null };
    }
    if (!Number.isSafeInteger(value.size) || Number(value.size) < 0 || Number(value.size) > MAX_BYTES ||
        typeof value.sha256 !== "string" || !HASH.test(value.sha256) || typeof value.modifiedAt !== "string" ||
        !Number.isFinite(Date.parse(value.modifiedAt)) || Date.parse(value.modifiedAt) < 0 || Date.parse(value.modifiedAt) > metadataNow + 300_000) fail();
    return { exists: true, size: Number(value.size), sha256: value.sha256, mtimeMs: Date.parse(value.modifiedAt) };
  }

  private validate(binding: RemoteWriteBinding) {
    if (g03PublicationTarget(binding.path) !== binding.path ||
        ![binding.operationId, binding.actorId, binding.projectId].every((value) => PUBLICATION_UUID.test(value)) ||
        !HASH.test(binding.sha256) || !["create", "replace"].includes(binding.writeOperation) ||
        (binding.writeOperation === "create" ? binding.expectedSha256 !== null : !HASH.test(binding.expectedSha256 ?? ""))) fail("PUBLICATION_INPUT_INVALID");
  }

  private result(value: Record<string, unknown>, binding: RemoteWriteBinding, query: boolean): RemoteWriteReceipt {
    const statuses = query ? ["committed", "rejected", "restored", "not_found"] : ["committed", "already_committed"];
    const hasBackup = binding.writeOperation === "replace" && ["committed", "already_committed", "restored"].includes(String(value.status));
    if (value.operationId !== binding.operationId || value.sha256 !== binding.sha256 ||
        value.previousSha256 !== binding.expectedSha256 || !statuses.includes(String(value.status)) ||
        value.backupId !== (hasBackup ? binding.operationId : null) ||
        (value.status === "restored" && binding.writeOperation !== "replace") ||
        value.sourceChecked !== (!query && value.status === "committed")) fail("PUBLICATION_REMOTE_UNCERTAIN");
    return { status: value.status as RemoteWriteReceipt["status"], operationId: binding.operationId,
      sha256: binding.sha256, previousSha256: binding.expectedSha256,
      backupId: hasBackup ? binding.operationId : null, checkedAt: String(value.checkedAt) };
  }

  async publish(binding: RemoteWriteBinding, data: Buffer) {
    this.validate(binding);
    if (!data.length || data.length > MAX_BYTES || createHash("sha256").update(data).digest("hex") !== binding.sha256) fail("PUBLICATION_CANDIDATE_MISMATCH");
    const { writeOperation, ...input } = binding;
    return this.result(await this.request(writeOperation, { ...input, base64: data.toString("base64") }), binding, false);
  }

  async receipt(binding: RemoteWriteBinding) {
    this.validate(binding);
    return this.result(await this.request("receipt", binding), binding, true);
  }
}
