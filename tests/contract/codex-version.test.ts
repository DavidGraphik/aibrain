import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const pinnedVersion = "0.162.1";

describe("pinned Codex App Server contract", () => {
  it("pins the worker binary to the generated contract version", async () => {
    const [dockerfile, packageJson] = await Promise.all([
      readFile(path.join(repositoryRoot, "Dockerfile"), "utf8"),
      readFile(path.join(repositoryRoot, "package.json"), "utf8"),
    ]);
    expect(dockerfile).toContain(`"@openai/codex@${pinnedVersion}"`);
    expect(dockerfile).toContain(`AIBRAIN_CODEX_EXPECTED_VERSION=${pinnedVersion}`);
    expect(dockerfile).not.toMatch(/ARG\s+(?:AIBRAIN_)?CODEX_VERSION/u);
    const scripts = (JSON.parse(packageJson) as { scripts: Record<string, string> }).scripts;
    expect(scripts["contracts:generate"]).toContain(`@openai/codex@${pinnedVersion}`);
    expect(scripts["contracts:verify"]).toContain("verify-codex-contracts.mjs");
  });

  it("uses pinned public native inputs without inheriting an old app or root process", async () => {
    const dockerfile = await readFile(path.join(repositoryRoot, "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/^ARG NODE_IMAGE=node:24\.18\.1-bookworm-slim@sha256:[a-f0-9]{64}\n/u);
    expect(dockerfile).toContain('FROM ${NODE_IMAGE} AS native-runtime');
    const native = dockerfile.slice(dockerfile.indexOf('FROM ${NODE_IMAGE} AS native-runtime'), dockerfile.indexOf('FROM native-runtime AS runtime'));
    expect(native).toContain('signed-by=/usr/share/keyrings/debian-archive-keyring.gpg');
    expect(native).toContain('snapshot.debian.org/archive/debian/20260820T000000Z');
    for (const dependency of ['bubblewrap', 'chromium-sandbox', 'libreoffice-writer', 'libreoffice-calc', 'libreoffice-impress', 'poppler-utils', 'restic']) expect(native).toContain(dependency);
    const runtime = dockerfile.slice(dockerfile.indexOf('FROM native-runtime AS runtime'));
    expect(runtime).toContain('FROM native-runtime AS runtime\nUSER root\nWORKDIR /');
    expect(runtime).not.toMatch(/apt-get|ARG\s+.*(?:IMAGE|BASE|CODEX_VERSION)/u);
    expect(runtime).toContain("source=/usr/local/lib/node_modules/npm,target=/opt/aibrain-build-npm,readonly");
    expect(runtime).toContain(`test "$(/usr/local/bin/codex-real --version)" = "codex-cli ${pinnedVersion}"`);
    const cleanOldApplication = runtime.indexOf("rm -rf /tmp/aibrain-npm-cache /app /opt/aibrain-horaria");
    const copyCurrentApplication = runtime.indexOf("COPY --from=builder --chown=aibrain:aibrain /app/.next/standalone");
    expect(cleanOldApplication).toBeGreaterThan(0);
    expect(copyCurrentApplication).toBeGreaterThan(cleanOldApplication);
    expect(runtime).toContain("test -x /usr/bin/bwrap");
    expect(runtime).toContain("test -x /usr/lib/chromium/chrome-sandbox");
    expect(runtime.match(/^USER .+$/gmu)?.at(-1)).toBe("USER aibrain:aibrain");
    expect(runtime).toContain('ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/aibrain-entrypoint"]');
    expect(runtime).toContain('CMD ["node", "server.js"]');
  });

  it("keeps one authoritative generated version instead of stale protocol copies", async () => {
    const entries = await readdir(path.join(repositoryRoot, "contracts", "codex"), { withFileTypes: true });
    expect(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)).toEqual([pinnedVersion]);
  });

  it("contains the aggregate request and event schemas used by the transport", async () => {
    const contractRoot = path.join(repositoryRoot, "contracts", "codex", pinnedVersion);
    const [clientRequest, serverRequest, serverNotification, generatedType] = await Promise.all([
      readFile(path.join(contractRoot, "schema", "ClientRequest.json"), "utf8"),
      readFile(path.join(contractRoot, "schema", "ServerRequest.json"), "utf8"),
      readFile(path.join(contractRoot, "schema", "ServerNotification.json"), "utf8"),
      readFile(path.join(contractRoot, "types", "ClientRequest.ts"), "utf8"),
    ]);

    expect(JSON.parse(clientRequest)).toMatchObject({ $schema: expect.any(String) });
    expect(JSON.parse(serverRequest)).toMatchObject({ $schema: expect.any(String) });
    expect(JSON.parse(serverNotification)).toMatchObject({ $schema: expect.any(String) });
    expect(generatedType).toContain("export type ClientRequest");
  });
});
