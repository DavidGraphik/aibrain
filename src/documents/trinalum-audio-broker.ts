import "server-only";
import { createHash } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import type { StagedDocument } from "./staging-store";
import { unixBrokerFetch } from "@/runtime/trinalum-broker-transport";
import { StorageError } from "@/storage/errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Installation/storage owner are resolved by server resource authorization, never request data. */
export async function trinalumAudioBroker(
  installationId: string,
  storageOwnerId: string,
  document: StagedDocument,
  source: Buffer,
  signal?: AbortSignal,
  options: { configPath?: string; fetcher?: typeof unixBrokerFetch } = {},
) {
  if (signal?.aborted) throw new StorageError("DOCUMENT_OPERATION_ABORTED", "Audio request cancelled.");
  if (installationId !== "trinalum-production" || !UUID.test(storageOwnerId) ||
      !UUID.test(document.threadId) || !UUID.test(document.uploadId) || document.kind !== "audio" ||
      document.relativePath !== path.posix.join("threads", document.threadId, "uploads", document.uploadId, document.fileName) ||
      !/^[0-9a-f]{64}$/.test(document.sha256) || !Number.isSafeInteger(document.size) ||
      typeof document.fileName !== "string" || document.fileName.length < 1 || document.fileName.length > 120 ||
      /[\/\\\u0000-\u001f\u007f]/u.test(document.fileName) || document.fileName.normalize("NFC") !== document.fileName ||
      !/\.(ogg|opus)$/i.test(document.fileName) || document.size < 1 || document.size > 20 * 1024 * 1024 || source.length !== document.size ||
      createHash("sha256").update(source).digest("hex") !== document.sha256) {
    throw new StorageError("DOCUMENT_AUDIO_INVALID", "Invalid audio identity.");
  }
  const configPath = options.configPath ?? process.env.AIBRAIN_TRINALUM_BRIDGE_CONFIG;
  if (!configPath || !path.isAbsolute(configPath)) throw new StorageError("DOCUMENT_AUDIO_UNAVAILABLE", "Broker unavailable.");
  let config;
  try { config = JSON.parse(await readFile(configPath, "utf8")); }
  catch { throw new StorageError("DOCUMENT_AUDIO_UNAVAILABLE", "Broker configuration unavailable."); }
  const binding = config.users?.[storageOwnerId];
  if (config.installationId !== installationId || config.socketPath !== "/run/trinalum-broker/broker.sock" ||
      binding?.status !== "active" || typeof binding.token !== "string" || binding.token.length < 32 || binding.token.length > 256) {
    throw new StorageError("DOCUMENT_AUDIO_UNAVAILABLE", "Broker identity unavailable.");
  }
  let response: Response;
  try {
    response = await (options.fetcher ?? unixBrokerFetch)(config.socketPath, new URL("http://127.0.0.1/audio-transcribe"), {
      method: "POST", headers: { Authorization: `Bearer ${binding.token}`, "Content-Type": "application/octet-stream",
        "Content-Length": String(source.length), "X-AiBrain-Audio-Identity": Buffer.from(JSON.stringify({ installationId,
          threadId: document.threadId, uploadId: document.uploadId, size: document.size, sha256: document.sha256 })).toString("base64") },
      body: new Uint8Array(source.buffer as ArrayBuffer, source.byteOffset, source.byteLength),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(325_000)]) : AbortSignal.timeout(325_000),
    }, { timeoutMs: 325_000 });
  } catch {
    throw new StorageError(signal?.aborted ? "DOCUMENT_OPERATION_ABORTED" : "DOCUMENT_AUDIO_UNAVAILABLE", "Audio broker request did not complete.");
  }
  if (response.status === 429) throw new StorageError("DOCUMENT_CONVERSION_BACKPRESSURE", "Audio broker occupied.");
  if (!response.ok) throw new StorageError(response.status === 400 ? "DOCUMENT_AUDIO_INVALID" : "DOCUMENT_AUDIO_UNAVAILABLE", "Audio broker rejected the request.");
  const result = await response.json().catch(() => null);
  if (!result || Object.keys(result).sort().join(",") !== "installationId,sha256,text,threadId,uploadId,userId" ||
      result.installationId !== installationId || result.userId !== storageOwnerId ||
      result.threadId !== document.threadId || result.uploadId !== document.uploadId || result.sha256 !== document.sha256 ||
      typeof result.text !== "string" || !result.text.trim() || Buffer.byteLength(result.text, "utf8") > 1024 * 1024 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/u.test(result.text)) {
    throw new StorageError("DOCUMENT_AUDIO_INVALID", "Broker transcript identity or content is invalid.");
  }
  if (signal?.aborted) throw new StorageError("DOCUMENT_OPERATION_ABORTED", "Audio request cancelled.");
  return result.text.trim();
}
