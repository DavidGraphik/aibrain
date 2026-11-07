import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("verifies mail protocol, TLS, message bounds and SMTP outcome boundaries without a real mailbox", async () => {
  const result = await promisify(execFile)("python3", ["scripts/test_nominalia_mail.py"], {
    cwd: process.cwd(), timeout: 15_000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, NODE_ENV: "test", PYTHONDONTWRITEBYTECODE: "1" },
  });
  expect(result.stderr).toMatch(/Ran \d+ tests/u);
  expect(result.stderr).toContain("OK");
});
