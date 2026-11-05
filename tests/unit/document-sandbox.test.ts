import { execFile as execFileCallback } from "node:child_process";
import { chmod, copyFile, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const source = path.resolve(process.cwd(), "infra/hetzner/app/soffice-safe.sh");
const launchers = ["soffice", "pdfinfo", "pdftoppm", "pdftotext", "qpdf"] as const;
const roots: string[] = [];

async function launcher(name: typeof launchers[number]) {
  const root = await mkdtemp("/tmp/aibrain-turn-document-");
  roots.push(root);
  const executable = path.join(root, `aibrain-${name}`);
  await copyFile(source, executable);
  await chmod(executable, 0o700);
  return { executable, root };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("document tool filesystem sandbox launcher", () => {
  it("allows descriptor cleanup while keeping clone3 denied with libc fallback", async () => {
    const profile = JSON.parse(await readFile("infra/hetzner/browser/seccomp_profile.json", "utf8"));
    const rules = profile.syscalls as { names: string[]; action: string; errnoRet?: number }[];
    expect(rules.find((rule) => rule.names.includes("close_range"))?.action).toBe("SCMP_ACT_ALLOW");
    expect(rules.filter((rule) => rule.names.includes("clone3"))).toEqual([
      expect.objectContaining({ action: "SCMP_ACT_ERRNO", errnoRet: 38 }),
    ]);
  });

  it.each([
    { statuses: [81, 0], calls: 2, exit: 0 },
    { statuses: [82, 81, 0], calls: 3, exit: 0 },
    { statuses: [81, 81, 81, 0], calls: 3, exit: 81 },
    { statuses: [82, 82, 82, 0], calls: 3, exit: 82 },
    { statuses: [1, 0], calls: 1, exit: 1 },
  ])("bounds native LibreOffice restarts for $statuses", async ({ statuses, calls, exit }) => {
    const test = await launcher("soffice");
    const wrapper = await readFile(source, "utf8");
    const loop = wrapper.match(/command=\(\/bin\/sh -c '(\s+attempt=1[\s\S]*?)' aibrain-office-restart/u)?.[1];
    expect(loop).toBeTruthy();
    const fake = path.join(test.root, "office.cjs");
    const log = path.join(test.root, "calls.json");
    await writeFile(fake, `const fs = require('node:fs'); const log = ${JSON.stringify(log)};
      const calls = fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, 'utf8')) : [];
      calls.push(process.argv.slice(2)); fs.writeFileSync(log, JSON.stringify(calls));
      process.exit(${JSON.stringify(statuses)}[calls.length - 1] ?? 99);`);
    const flags = ["--headless", "--safe-mode", "--norestore", "-env:UserInstallation=file:///work/lo-profile", "a file.pptx"];
    const result = await execFile("/bin/sh", ["-c", loop!, "aibrain-office-restart", process.execPath, fake, ...flags], { cwd: test.root })
      .then(() => 0, (error: { code: number }) => error.code);
    expect(result).toBe(exit);
    expect(JSON.parse(await readFile(log, "utf8"))).toEqual(Array.from({ length: calls }, () => flags));
  });

  it("keeps proc empty and read-only with private writable headless caches", async () => {
    const wrapper = await readFile(source, "utf8");
    expect(wrapper).toContain("--tmpfs /proc");
    expect(wrapper).toContain("--remount-ro /proc");
    expect(wrapper).not.toMatch(/--(?:ro-bind|proc) \/proc/u);
    expect(wrapper).toContain("--setenv XDG_CACHE_HOME /work/home/.cache");
    expect(wrapper).toContain("--setenv LD_LIBRARY_PATH /usr/lib/libreoffice/program");
    expect(wrapper).toContain("--setenv SAL_USE_VCLPLUGIN svp");
  });

  it.each(launchers)("rejects an absolute path outside private work for %s", async (name) => {
    const test = await launcher(name);
    await expect(execFile(test.executable, ["/etc/passwd"], { cwd: test.root }))
      .rejects.toMatchObject({ code: 78, stderr: expect.stringContaining("absolute argument escapes") });
  });

  it("rejects LibreOffice without every non-interactive safety flag", async () => {
    const test = await launcher("soffice");
    const physicalRoot = await realpath(test.root);
    await expect(execFile(test.executable, [
      `-env:UserInstallation=file://${path.join(physicalRoot, "lo-profile")}`,
      "--headless",
      "--norestore",
    ], { cwd: test.root }))
      .rejects.toMatchObject({ code: 78, stderr: expect.stringContaining("--safe-mode") });
  });

  it("rejects parent traversal before any document tool starts", async () => {
    const test = await launcher("pdfinfo");
    await expect(execFile(test.executable, ["../sibling/document.pdf"], { cwd: test.root }))
      .rejects.toMatchObject({ code: 78, stderr: expect.stringContaining("parent traversal") });
  });
});
