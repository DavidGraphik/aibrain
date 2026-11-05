import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { trinalumAudioBroker } from "./trinalum-audio-broker";
import type { StagedDocument } from "./staging-store";
import type { unixBrokerFetch } from "@/runtime/trinalum-broker-transport";
import { oggOpusFixture } from "../../tests/helpers/ogg-opus-fixture";
import { validateUploadedDocument } from "./upload-validation";

vi.mock("server-only", () => ({}));
const userId = "11111111-1111-4111-8111-111111111111";
const threadId = "22222222-2222-4222-8222-222222222222";
const uploadId = "33333333-3333-4333-8333-333333333333";
const bytes = oggOpusFixture();
const document = { threadId, uploadId, fileName: "voice.ogg", relativePath: `threads/${threadId}/uploads/${uploadId}/voice.ogg`,
  kind: "audio", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } as StagedDocument;
const reply = { installationId: "trinalum-production", userId, threadId, uploadId, sha256: document.sha256, text: "Synthetic client transcript only" };
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function config() {
  const root = await mkdtemp(path.join(process.cwd(), ".audio-broker-test-")); roots.push(root);
  const configPath = path.join(root, "bridge.json");
  await writeFile(configPath, JSON.stringify({ installationId: "trinalum-production", socketPath: "/run/trinalum-broker/broker.sock",
    users: { [userId]: { status: "active", token: "c".repeat(64) } } }), { mode: 0o600 });
  return configPath;
}

it("denies foreign installations before credential reads and foreign owners before dispatch", async () => {
  const fetcher = vi.fn<typeof unixBrokerFetch>();
  await expect(trinalumAudioBroker("arnall", userId, document, bytes, undefined, { configPath: "/missing", fetcher })).rejects.toThrow();
  await expect(trinalumAudioBroker("trinalum-production", "44444444-4444-4444-8444-444444444444", document, bytes, undefined,
    { configPath: await config(), fetcher })).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

it("sends only fixed recording identity with existing owner credentials and accepts an exactly bound response", async () => {
  const fetcher = vi.fn<typeof unixBrokerFetch>(async () => Response.json(reply));
  const result = await trinalumAudioBroker("trinalum-production", userId, document, bytes, undefined, { configPath: await config(), fetcher });
  expect(result).toBe(reply.text);
  const [socket, url, init, limits] = fetcher.mock.calls[0]!;
  expect(socket).toBe("/run/trinalum-broker/broker.sock"); expect(url.pathname).toBe("/audio-transcribe");
  expect(JSON.parse(Buffer.from((init.headers as Record<string, string>)["X-AiBrain-Audio-Identity"]!, "base64").toString())).toEqual({ installationId: "trinalum-production", threadId, uploadId,
    size: document.size, sha256: document.sha256 });
  expect(Buffer.from(init.body as Uint8Array)).toEqual(bytes);
  expect(limits).toEqual({ timeoutMs: 325_000 });
  expect(init.signal).toBeInstanceOf(AbortSignal);
});

it.each([{ userId: "44444444-4444-4444-8444-444444444444" }, { installationId: "arnall" }, { sha256: "f".repeat(64) },
  { threadId: userId }, { uploadId: userId }, { text: "" }, { text: "\0bad" }, { text: "x".repeat(1024 * 1024 + 1) }, { privatePath: "/host" }])(
  "rejects stale/foreign/malformed output %#", async (patch) => {
    await expect(trinalumAudioBroker("trinalum-production", userId, document, bytes, undefined, {
      configPath: await config(), fetcher: async () => Response.json({ ...reply, ...patch }),
    })).rejects.toMatchObject({ code: "DOCUMENT_AUDIO_INVALID" });
  },
);

it("does not mask cancellation or backpressure and never falls back to a generic connector", async () => {
  const configPath = await config(); const controller = new AbortController(); controller.abort();
  const fetcher = vi.fn<typeof unixBrokerFetch>();
  await expect(trinalumAudioBroker("trinalum-production", userId, document, bytes, controller.signal, { configPath, fetcher })).rejects.toMatchObject({ code: "DOCUMENT_OPERATION_ABORTED" });
  expect(fetcher).not.toHaveBeenCalled();
  await expect(trinalumAudioBroker("trinalum-production", userId, document, bytes, undefined, {
    configPath, fetcher: async () => Response.json({ error: "AUDIO_BUSY" }, { status: 429 }),
  })).rejects.toMatchObject({ code: "DOCUMENT_CONVERSION_BACKPRESSURE" });
  await expect(trinalumAudioBroker("trinalum-production", userId, document, bytes, undefined, {
    configPath, fetcher: async () => Response.json({ error: "private operator diagnostic" }, { status: 503 }),
  })).rejects.toThrow("Audio broker rejected the request.");
});

it("server-service binds the opted-in callback to the authorized storage owner and preserves original bytes", async () => {
  const { loadInstallationConfig } = await import("@/config/installation");
  const { documentServicesForUser } = await import("./server-service");
  const transport = await import("@/runtime/trinalum-broker-transport");
  const root = await mkdtemp(path.join(process.cwd(), ".audio-broker-test-")); roots.push(root);
  const configPath = path.join(root, "installation.json"), dataRoot = path.join(root, "data");
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, installationId: "trinalum-production", companyName: "Synthetic Audio Lab",
    companySlug: "trinalum-production", publicUrl: "http://localhost:3000", branding: { productName: "Audio Lab", logoPath: "/brand/logo.svg", faviconPath: "/brand/favicon.svg", accentColor: "#334455" },
    paths: { dataRoot, usersRoot: path.join(dataRoot, "users"), companyContextRoot: path.join(dataRoot, "company"),
      sourceReadRoot: path.join(root, "source-ro"), publishWriteRoot: path.join(root, "publish-rw"), backupsRoot: path.join(dataRoot, "backups") } }));
  vi.stubEnv("AIBRAIN_INSTALLATION_CONFIG", configPath);
  vi.stubEnv("AIBRAIN_TRINALUM_BRIDGE_CONFIG", await config());
  vi.stubEnv("AIBRAIN_TRINALUM_AUDIO_BROKER_ENABLED", "1");
  const fetcher = vi.spyOn(transport, "unixBrokerFetch").mockImplementation(async (_socket, _url, init) => {
    const source = JSON.parse(Buffer.from((init.headers as Record<string, string>)["X-AiBrain-Audio-Identity"]!, "base64").toString());
    return Response.json({ ...reply, sha256: source.sha256 });
  });
  const services = await documentServicesForUser(await loadInstallationConfig(), userId);
  const original = oggOpusFixture();
  const staged = await services.staging.stage({ threadId, uploadId, data: original,
    validated: validateUploadedDocument({ data: original, fileName: "voice.ogg", declaredMimeType: "audio/ogg" }) });
  const preview = await services.previews.create(staged);
  expect(preview).toMatchObject({ kind: "audio", sourceSha256: staged.sha256, status: "ready" });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await services.previews.readFile(threadId, uploadId, "preview.txt")).toEqual(Buffer.from(reply.text));
  expect(await readFile(path.join(services.staging.rootDirectory, staged.relativePath))).toEqual(original);
});


it("sanitizes malformed private configuration before any broker dispatch", async () => {
  const configPath = await config(); const fetcher = vi.fn<typeof unixBrokerFetch>();
  await writeFile(configPath, '{"token":"private-test-marker"');
  await expect(trinalumAudioBroker("trinalum-production", userId, document, bytes, undefined, { configPath, fetcher }))
    .rejects.toMatchObject({ code: "DOCUMENT_AUDIO_UNAVAILABLE", message: "Broker configuration unavailable." });
  expect(fetcher).not.toHaveBeenCalled();
});
