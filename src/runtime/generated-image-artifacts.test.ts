import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resourceLocationIndexForInstallation } from "@/library/server-resource-access";
import {
  decodeGeneratedPngResult,
  generatedImageArtifactId,
  persistGeneratedImageArtifact,
} from "@/runtime/generated-image-artifacts";
import { generatedPngFixture } from "../../tests/helpers/png-fixture";

vi.mock("server-only", () => ({}));

const USER_ID = "0198b9f0-6631-7000-8000-000000000401";
const PROJECT_ID = "0198b9f0-6631-7000-8000-000000000411";
const THREAD_ID = "0198b9f0-6631-7000-8000-000000000412";
const MESSAGE_ID = "0198b9f0-6631-7000-8000-000000000413";
const PNG = generatedPngFixture();

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-generated-image-"));
  roots.push(root);
  const installation = {
    installationId: "generated-image-qa",
    paths: {
      dataRoot: path.join(root, "data"),
      usersRoot: path.join(root, "users"),
      companyContextRoot: path.join(root, "company-context"),
      sourceReadRoot: path.join(root, "source-ro"),
      publishWriteRoot: path.join(root, "publish-rw"),
      backupsRoot: path.join(root, "backups"),
    },
  };
  const projectWorkspace = path.join(root, "users", USER_ID, "workspace", "projects", PROJECT_ID);
  await Promise.all([
    mkdir(projectWorkspace, { recursive: true, mode: 0o700 }),
    mkdir(installation.paths.dataRoot, { recursive: true, mode: 0o700 }),
  ]);
  return {
    installation,
    projectWorkspace,
    context: {
      installation,
      projectWorkspace,
      projectId: PROJECT_ID,
      threadId: THREAD_ID,
      messageId: MESSAGE_ID,
      storageOwnerId: USER_ID,
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("generated image artifacts", () => {
  it("accepts only real bounded PNG bytes, never JSON or an arbitrary base64 string", () => {
    expect(decodeGeneratedPngResult(PNG.toString("base64"))).toEqual(PNG);
    expect(decodeGeneratedPngResult(`data:image/png;base64,${PNG.toString("base64")}`)).toEqual(PNG);
    expect(decodeGeneratedPngResult('{"image_url":"/tmp/image.png"}')).toBeNull();
    expect(decodeGeneratedPngResult(Buffer.from("not a png").toString("base64"))).toBeNull();
    expect(decodeGeneratedPngResult(Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      Buffer.alloc(80),
    ]).toString("base64"))).toBeNull();
    const impossibleDimensions = Buffer.from(PNG);
    impossibleDimensions.writeUInt32BE(20_000, 16);
    expect(decodeGeneratedPngResult(impossibleDimensions.toString("base64"))).toBeNull();
    expect(decodeGeneratedPngResult("%%%%")).toBeNull();
  });

  it("persists, verifies and indexes a generated PNG before returning its authenticated URL", async () => {
    const files = await fixture();
    const artifact = await persistGeneratedImageArtifact({
      id: "native-image-item-1",
      type: "imageGeneration",
      result: `data:image/png;base64,${PNG.toString("base64")}`,
      revisedPrompt: "Una imagen real",
      failure: null,
    }, files.context);

    expect(artifact).not.toBeNull();
    expect(artifact).toMatchObject({ width: PNG.readUInt32BE(16), height: PNG.readUInt32BE(20) });
    expect(artifact?.name).toMatch(/^imagen-[0-9a-f]{8}\.png$/u);
    expect(artifact?.name).not.toContain(".png.json");
    expect(artifact?.url).toBe(`/api/projects/${PROJECT_ID}/artifacts/${artifact?.id}`);
    const relativePath = `generated-image-artifacts/${artifact?.id}.png`;
    const persisted = await readFile(path.join(files.installation.paths.dataRoot, relativePath));
    expect(persisted.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(persisted.byteLength).toBeGreaterThan(1_000);

    const binding = await resourceLocationIndexForInstallation(files.installation)
      .binding("generated-image", artifact!.id);
    expect(binding).toMatchObject({
      projectId: PROJECT_ID,
      threadId: THREAD_ID,
      messageId: MESSAGE_ID,
      storageOwnerId: USER_ID,
      relativePath,
      fileName: artifact?.name,
      mediaType: "image/png",
      size: PNG.byteLength,
      sha256: createHash("sha256").update(PNG).digest("hex"),
    });

    await expect(persistGeneratedImageArtifact({
      id: "native-image-item-1",
      type: "imageGeneration",
      result: PNG.toString("base64"),
      revisedPrompt: "Una imagen real",
      failure: null,
    }, files.context)).resolves.toEqual(artifact);
  });

  it("uses a validated in-workspace savedPath fallback without exposing that path", async () => {
    const files = await fixture();
    const savedPath = path.join(files.projectWorkspace, "generated", "source.png");
    await mkdir(path.dirname(savedPath), { recursive: true, mode: 0o700 });
    await writeFile(savedPath, PNG, { mode: 0o600 });
    const artifact = await persistGeneratedImageArtifact({
      id: "native-image-item-2",
      type: "imageGeneration",
      result: "not-base64",
      savedPath,
      revisedPrompt: null,
      failure: null,
    }, files.context);
    expect(artifact?.url).toMatch(/^\/api\/projects\/[0-9a-f-]+\/artifacts\/[0-9a-f-]+$/u);
    expect(JSON.stringify(artifact)).not.toContain(files.projectWorkspace);
  });

  it("does not persist a failed or invalid image result", async () => {
    const files = await fixture();
    await expect(persistGeneratedImageArtifact({
      id: "native-image-item-3",
      type: "imageGeneration",
      result: '{"path":"image.png"}',
      failure: null,
    }, files.context)).resolves.toBeNull();
    await expect(persistGeneratedImageArtifact({
      type: "imageGeneration",
      result: PNG.toString("base64"),
      failure: null,
    }, files.context)).resolves.toBeNull();
    await expect(persistGeneratedImageArtifact({
      id: "native-image-item-4",
      type: "imageGeneration",
      result: PNG.toString("base64"),
      failure: { type: "usageLimitExceeded" },
    }, files.context)).resolves.toBeNull();
    expect(await resourceLocationIndexForInstallation(files.installation)
      .listForProjects(new Set([PROJECT_ID]), "generated-image")).toEqual([]);
  });

  it("publishes one complete immutable file under concurrent identical retries", async () => {
    const files = await fixture();
    const item = {
      id: "native-image-race-identical",
      type: "imageGeneration",
      result: PNG.toString("base64"),
      failure: null,
    } as const;
    const results = await Promise.all(
      Array.from({ length: 12 }, () => persistGeneratedImageArtifact(item, files.context)),
    );

    expect(new Set(results.map((result) => result?.id))).toHaveLength(1);
    const [artifact] = results;
    const directory = path.join(files.installation.paths.dataRoot, "generated-image-artifacts");
    expect(await readdir(directory)).toEqual([`${artifact?.id}.png`]);
    expect(await readFile(path.join(directory, `${artifact?.id}.png`))).toEqual(PNG);
  });

  it("never exposes partial target bytes while publishing a large PNG", async () => {
    const files = await fixture();
    const largePng = generatedPngFixture(1_024, 1_024);
    const itemId = "native-image-atomic-visibility";
    const artifactId = generatedImageArtifactId(MESSAGE_ID, itemId);
    const target = path.join(
      files.installation.paths.dataRoot,
      "generated-image-artifacts",
      `${artifactId}.png`,
    );
    let completed = false;
    const persistence = persistGeneratedImageArtifact({
      id: itemId,
      type: "imageGeneration",
      result: largePng.toString("base64"),
      failure: null,
    }, files.context).finally(() => {
      completed = true;
    });
    const observedSizes: number[] = [];
    while (!completed) {
      try {
        observedSizes.push((await readFile(target)).byteLength);
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await expect(persistence).resolves.not.toBeNull();
    expect(observedSizes.every((size) => size === largePng.byteLength)).toBe(true);
    // Buffer.equals compares every byte natively; deep object equality walks
    // four million numeric properties and can consume the entire test budget.
    expect((await readFile(target)).equals(largePng)).toBe(true);
  });

  it("allows only one complete value to win a stable-id content race", async () => {
    const files = await fixture();
    const competing = generatedPngFixture(48, 48);
    const base = {
      id: "native-image-race-conflict",
      type: "imageGeneration",
      failure: null,
    } as const;
    const settled = await Promise.allSettled([
      persistGeneratedImageArtifact({ ...base, result: PNG.toString("base64") }, files.context),
      persistGeneratedImageArtifact({ ...base, result: competing.toString("base64") }, files.context),
    ]);

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    const artifactId = generatedImageArtifactId(MESSAGE_ID, base.id);
    const persisted = await readFile(path.join(
      files.installation.paths.dataRoot,
      "generated-image-artifacts",
      `${artifactId}.png`,
    ));
    expect([PNG, competing].some((candidate) => candidate.equals(persisted))).toBe(true);
  });

  it("rejects a symlinked server-owned artifact root without touching its destination", async () => {
    const files = await fixture();
    const outside = path.join(path.dirname(files.installation.paths.dataRoot), "outside-artifacts");
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, path.join(files.installation.paths.dataRoot, "generated-image-artifacts"));

    await expect(persistGeneratedImageArtifact({
      id: "native-image-root-symlink",
      type: "imageGeneration",
      result: PNG.toString("base64"),
      failure: null,
    }, files.context)).rejects.toThrow("artifact directory is unsafe");
    expect(await readdir(outside)).toEqual([]);
  });

  it("never follows an existing target symlink", async () => {
    const files = await fixture();
    const itemId = "native-image-target-symlink";
    const artifactId = generatedImageArtifactId(MESSAGE_ID, itemId);
    const artifactRoot = path.join(files.installation.paths.dataRoot, "generated-image-artifacts");
    const outside = path.join(path.dirname(files.installation.paths.dataRoot), "outside.png");
    await mkdir(artifactRoot, { mode: 0o700 });
    await writeFile(outside, "do-not-replace", { mode: 0o600 });
    await symlink(outside, path.join(artifactRoot, `${artifactId}.png`));

    await expect(persistGeneratedImageArtifact({
      id: itemId,
      type: "imageGeneration",
      result: PNG.toString("base64"),
      failure: null,
    }, files.context)).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe("do-not-replace");
    expect(await readdir(artifactRoot)).toEqual([`${artifactId}.png`]);
  });
});
