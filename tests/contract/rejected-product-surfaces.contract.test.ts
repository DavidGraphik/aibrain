import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

async function exists(relativePath: string) {
  try {
    await access(path.join(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

describe("rejected product surfaces", () => {
  it("does not compile routes or panels for onboarding or a remote control plane", async () => {
    for (const relativePath of [
      "src/app/control/page.tsx",
      "src/app/onboarding/page.tsx",
      "src/app/api/control-plane/automations/route.ts",
      "src/app/api/control-plane/invitations/route.ts",
      "src/app/api/control-plane/manifest/route.ts",
      "src/app/api/onboarding/member/route.ts",
      "src/components/control-plane-form.tsx",
      "src/components/member-onboarding.tsx",
      "src/components/runtime-panel.tsx",
    ]) {
      expect(await exists(relativePath), relativePath).toBe(false);
    }
  });

  it("keeps auth role-free and documents the exact product boundary", async () => {
    const authTypes = await readFile(path.join(root, "src/auth/types.ts"), "utf8");
    const session = await readFile(path.join(root, "src/auth/session.ts"), "utf8");
    const contract = await readFile(path.join(root, "docs/UI_BACKEND_CONTRACT.md"), "utf8");
    expect(authTypes).not.toMatch(/UserRole|owner|member/u);
    expect(session).not.toMatch(/user\.role|account\.role/u);
    expect(contract).not.toMatch(/\/api\/control-plane/u);
    expect(contract).toContain("AiBrain no envía invitaciones ni publica un control plane remoto.");
    expect(contract).toContain("Las automatizaciones programadas son locales");
    expect(contract).toContain("### Centro de administración del workspace");
  });
});
