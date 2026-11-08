import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";

it("publishes and rolls back context with conflict, policy and symlink protection", () => {
  expect(() => execFileSync("python3", [path.join(process.cwd(), "scripts/update-company-context.test.py")], {
    timeout: 30_000, stdio: "pipe",
  })).not.toThrow();
});
