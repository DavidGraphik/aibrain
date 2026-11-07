import { closeSync, constants, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const EXPECTED_PLACEHOLDERS = [
  "__AIBRAIN_INSTANCE_TOKEN__",
  "__AIBRAIN_PUBLIC_HOST__",
  "__AIBRAIN_HTTP_PORT__",
];

function fail(message) {
  process.stderr.write(`Nginx renderer failed: ${message}\n`);
  process.exit(64);
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail("expected --key value arguments");
    if (values.has(key)) fail(`duplicate argument ${key}`);
    values.set(key, value);
  }
  for (const key of ["--installation", "--host", "--port", "--output"]) {
    if (!values.has(key)) fail(`missing ${key}`);
  }
  if (values.size !== 4) fail("unknown argument");
  return Object.fromEntries([...values].map(([key, value]) => [key.slice(2), value]));
}

function render(template, values) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u.test(values.installation)) {
    fail("installation must be a lowercase DNS-safe slug of 1-40 characters");
  }
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(values.host)) {
    fail("host must be a lowercase ASCII FQDN");
  }
  if (!/^[0-9]+$/u.test(values.port)) fail("port must be numeric");
  const port = Number(values.port);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) fail("port must be between 1024 and 65535");

  let templateWithoutExpectedTokens = template;
  for (const placeholder of EXPECTED_PLACEHOLDERS) {
    templateWithoutExpectedTokens = templateWithoutExpectedTokens.replaceAll(placeholder, "");
  }
  const unexpected = [...templateWithoutExpectedTokens.matchAll(/__[A-Z0-9_]+__/gu)].map((match) => match[0]);
  if (unexpected.length > 0) fail(`unexpected template token ${unexpected[0]}`);
  for (const placeholder of EXPECTED_PLACEHOLDERS) {
    if (!template.includes(placeholder)) fail(`template is missing ${placeholder}`);
  }

  const token = values.installation.replaceAll("-", "_");
  const rendered = template
    .replaceAll("__AIBRAIN_INSTANCE_TOKEN__", token)
    .replaceAll("__AIBRAIN_PUBLIC_HOST__", values.host)
    .replaceAll("__AIBRAIN_HTTP_PORT__", String(port));
  if (/__[A-Z0-9_]+__/u.test(rendered)) fail("rendered configuration contains an unresolved token");
  return rendered;
}

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(import.meta.dirname, "..");
const templatePath = path.join(root, "infra/hetzner/nginx/aibrain.conf.example");
const template = readFileSync(templatePath, "utf8");
const outputPath = path.resolve(args.output);
const rendered = render(template, args);
let descriptor;
try {
  descriptor = openSync(outputPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  writeFileSync(descriptor, rendered, "utf8");
} catch (error) {
  fail(error instanceof Error ? error.message : "cannot create output");
} finally {
  if (descriptor !== undefined) closeSync(descriptor);
}
process.stdout.write(`${outputPath}\n`);
