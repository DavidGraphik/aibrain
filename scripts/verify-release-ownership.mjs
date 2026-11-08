#!/usr/bin/env node

// Read-only fleet-selector preflight. The transactional manager enforces the
// same mapping again even when an operator bypasses this convenience entrypoint.
import { assertReleaseOwnership } from "./manage-release.mjs";

const names = new Map([
  ["--source-repository", "sourceRepository"],
  ["--installation-id", "installationId"],
  ["--image", "image"],
  ["--egress-image", "egressImage"],
]);
try {
  const args = process.argv.slice(2);
  const input = {};
  if (args.length !== names.size * 2) throw new Error("Expected source repository, installation ID and both immutable images.");
  for (let index = 0; index < args.length; index += 2) {
    const key = names.get(args[index]);
    if (!key || Object.hasOwn(input, key) || !args[index + 1]) throw new Error("Unknown, duplicate or missing ownership argument.");
    input[key] = args[index + 1];
  }
  const owner = assertReleaseOwnership(input);
  process.stdout.write(`${JSON.stringify({ installationId: input.installationId, repository: owner.repository, eligible: true })}\n`);
} catch (error) {
  process.stderr.write(`${error.code ?? "RELEASE_OWNERSHIP_USAGE"}: ${error.message}\n`);
  process.exitCode = 1;
}
