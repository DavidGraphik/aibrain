#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { link, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";

const SCHEMA_VERSION = 1;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

const HELP = `Crea un InstallationConfig v1 sintético y sin secretos.

Uso:
  node scripts/create-installation.mjs \\
    --installation-id acme-production \\
    --company-name "Acme Consulting" \\
    --company-slug acme-consulting \\
    --public-url https://brain.acme.example \\
    --product-name "Acme Brain" \\
    --accent-color '#315ee7' \\
    --data-root /var/lib/aibrain-acme \\
    --source-read-root /mnt/aibrain-acme/source-ro \\
    --publish-write-root /mnt/aibrain-acme/publish-rw

Opcionales:
  --logo-path /branding/acme/logo.svg
  --favicon-path /branding/acme/favicon.svg
  --company-context-root /var/lib/aibrain-acme/company
  --users-root /var/lib/aibrain-acme/users
  --backups-root /var/lib/aibrain-acme/backups
  --output /ruta/absoluta/installation.json
`;

function fail(message) {
  process.stderr.write(`Error: ${message}\n\n${HELP}`);
  process.exitCode = 1;
  return null;
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") return { help: true, values };
    if (!token.startsWith("--")) throw new Error(`argumento inesperado: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`falta el valor de --${key}`);
    if (values.has(key)) throw new Error(`--${key} no puede repetirse`);
    values.set(key, value);
    index += 1;
  }
  return { help: false, values };
}

function requireValue(values, key) {
  const value = values.get(key);
  if (!value) throw new Error(`--${key} es obligatorio`);
  if (value.trim() !== value || value.length === 0) {
    throw new Error(`--${key} no puede estar vacío ni contener espacios exteriores`);
  }
  return value;
}

function validateIdentifier(value, flag) {
  if (value.length < 2 || value.length > 63 || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`--${flag} debe tener 2–63 caracteres en minúscula y usar solo letras, números o guiones simples`);
  }
  return value;
}

function validateAbsolutePath(value, flag) {
  if (!path.posix.isAbsolute(value) || value === "/" || path.posix.normalize(value) !== value) {
    throw new Error(`--${flag} debe ser una ruta POSIX absoluta, normalizada y distinta de /`);
  }
  return value;
}

function validateAssetPath(value, flag) {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.includes("%") ||
    value.includes("?") ||
    value.includes("#") ||
    path.posix.normalize(value) !== value
  ) {
    throw new Error(`--${flag} debe ser un path público absoluto y normalizado`);
  }
  return value;
}

function validatePublicUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("--public-url debe usar HTTP o HTTPS");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("--public-url debe ser un origen sin credenciales, path, query ni fragmento");
  }
  const localHostnames = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (url.protocol === "http:" && !localHostnames.has(url.hostname)) {
    throw new Error("--public-url debe usar HTTPS salvo en localhost");
  }
  return url.origin;
}

function ensureStrictDescendant(parent, candidate, flag) {
  const relative = path.posix.relative(parent, candidate);
  if (!relative || relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
    throw new Error(`--${flag} debe estar dentro de --data-root`);
  }
  return candidate;
}

function buildConfig(values) {
  const allowed = new Set([
    "installation-id",
    "company-name",
    "company-slug",
    "public-url",
    "product-name",
    "accent-color",
    "logo-path",
    "favicon-path",
    "data-root",
    "company-context-root",
    "users-root",
    "source-read-root",
    "publish-write-root",
    "backups-root",
    "output",
  ]);
  for (const key of values.keys()) {
    if (!allowed.has(key)) throw new Error(`flag desconocido: --${key}`);
  }

  const installationId = validateIdentifier(requireValue(values, "installation-id"), "installation-id");
  const companySlug = validateIdentifier(requireValue(values, "company-slug"), "company-slug");
  const companyName = requireValue(values, "company-name");
  const productName = requireValue(values, "product-name");
  if (companyName.length > 120) throw new Error("--company-name supera 120 caracteres");
  if (productName.length > 80) throw new Error("--product-name supera 80 caracteres");
  const accentColor = requireValue(values, "accent-color").toLowerCase();
  if (!COLOR_PATTERN.test(accentColor)) throw new Error("--accent-color debe usar #RRGGBB");

  const dataRoot = validateAbsolutePath(requireValue(values, "data-root"), "data-root");
  const companyContextRoot = ensureStrictDescendant(
    dataRoot,
    validateAbsolutePath(values.get("company-context-root") ?? path.posix.join(dataRoot, "company"), "company-context-root"),
    "company-context-root",
  );
  const usersRoot = ensureStrictDescendant(
    dataRoot,
    validateAbsolutePath(values.get("users-root") ?? path.posix.join(dataRoot, "users"), "users-root"),
    "users-root",
  );
  const backupsRoot = ensureStrictDescendant(
    dataRoot,
    validateAbsolutePath(values.get("backups-root") ?? path.posix.join(dataRoot, "backups"), "backups-root"),
    "backups-root",
  );
  const sourceReadRoot = validateAbsolutePath(requireValue(values, "source-read-root"), "source-read-root");
  const publishWriteRoot = validateAbsolutePath(requireValue(values, "publish-write-root"), "publish-write-root");
  const allPaths = [dataRoot, companyContextRoot, usersRoot, sourceReadRoot, publishWriteRoot, backupsRoot];
  if (new Set(allPaths).size !== allPaths.length) throw new Error("todas las rutas deben ser diferentes");

  return {
    schemaVersion: SCHEMA_VERSION,
    installationId,
    companyName,
    companySlug,
    publicUrl: validatePublicUrl(requireValue(values, "public-url")),
    branding: {
      productName,
      logoPath: validateAssetPath(values.get("logo-path") ?? `/branding/${companySlug}/logo.svg`, "logo-path"),
      faviconPath: validateAssetPath(values.get("favicon-path") ?? `/branding/${companySlug}/favicon.svg`, "favicon-path"),
      accentColor,
    },
    paths: {
      dataRoot,
      companyContextRoot,
      usersRoot,
      sourceReadRoot,
      publishWriteRoot,
      backupsRoot,
    },
  };
}

async function writeExclusiveAtomic(target, contents) {
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o755 });
  const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
  let linked = false;
  try {
    const handle = await open(temporary, "wx", 0o644);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporary, target);
    linked = true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") {
      throw new Error(`el destino ya existe: ${target}`);
    }
    throw error;
  } finally {
    try {
      await unlink(temporary);
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
    }
  }
  if (!linked) throw new Error(`no se pudo crear ${target}`);
}

async function main() {
  let parsed;
  try {
    parsed = parseArguments(process.argv.slice(2));
    if (parsed.help) {
      process.stdout.write(HELP);
      return;
    }
    const config = buildConfig(parsed.values);
    const requestedOutput = parsed.values.get("output") ?? path.join("config", "installations", `${config.installationId}.json`);
    const output = path.resolve(process.cwd(), requestedOutput);
    await writeExclusiveAtomic(output, `${JSON.stringify(config, null, 2)}\n`);
    process.stdout.write(`InstallationConfig creado: ${output}\n`);
    process.stdout.write(`Actívalo con AIBRAIN_INSTALLATION_CONFIG=${output}\n`);
  } catch (error) {
    fail(error instanceof Error ? error.message : "fallo desconocido");
  }
}

await main();
