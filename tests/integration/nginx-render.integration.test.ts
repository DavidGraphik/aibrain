import { execFile } from "node:child_process";
import { mkdtemp, readFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const script = path.resolve("scripts/render-nginx-config.mjs");

async function render(root: string, installation: string, host: string, port: number) {
  const output = path.join(root, `${installation}.conf`);
  await execFileAsync(process.execPath, [script, "--installation", installation, "--host", host, "--port", String(port), "--output", output]);
  return readFile(output, "utf8");
}

describe("per-installation Nginx rendering", () => {
  it("renders two installations with disjoint upstreams and rate-limit zones", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aibrain-nginx-"));
    const alpha = await render(root, "company-alpha", "alpha.example.com", 3100);
    const beta = await render(root, "company-beta", "beta.example.com", 3200);

    expect(alpha).toContain("zone=aibrain_company_alpha_auth:10m");
    expect(alpha).toContain("upstream aibrain_company_alpha_backend");
    expect(alpha).toContain("server 127.0.0.1:3100");
    expect(alpha).toContain("return 301 https://alpha.example.com$request_uri");
    expect(alpha).toContain("location ^~ /.well-known/acme-challenge/");
    expect(alpha).toContain("root /var/www/aibrain-acme");
    expect(alpha).toContain('location ~ "^/api/threads/[0-9a-f-]{36}/documents$"');
    expect(alpha).toContain("http2 on;");
    expect(beta).toContain("zone=aibrain_company_beta_auth:10m");
    expect(beta).toContain("upstream aibrain_company_beta_backend");
    expect(beta).not.toContain("aibrain_company_alpha");
    expect(alpha).not.toMatch(/__[A-Z0-9_]+__/u);
  });

  it("rejects injection, low ports, existing outputs and symlink outputs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aibrain-nginx-invalid-"));
    await expect(render(root, "company;include", "alpha.example.com", 3100)).rejects.toThrow();
    await expect(render(root, "company-alpha", "alpha.example.com", 443)).rejects.toThrow();
    await render(root, "company-alpha", "alpha.example.com", 3100);
    await expect(render(root, "company-alpha", "alpha.example.com", 3100)).rejects.toThrow();
    const target = path.join(root, "target.conf");
    await symlink(target, path.join(root, "company-beta.conf"));
    await expect(render(root, "company-beta", "beta.example.com", 3200)).rejects.toThrow();
  });
});
