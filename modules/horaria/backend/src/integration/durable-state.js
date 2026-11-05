import { lstatSync, mkdirSync, writeFileSync, renameSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/** Private service volume, outside the checkout and any employee workspace. */
export function stateDirectory() {
  const root = process.env.HORARIA_STATE_ROOT;
  if (!root || !path.isAbsolute(root)) throw new Error('HORARIA_STATE_ROOT must be an absolute private directory');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077)) throw new Error("Horaria state directory must be private (0700)");
  return root;
}
export function saveState(name, data) {
  if (!/^[a-z0-9-]+\.json$/.test(name)) throw new Error('Invalid state name');
  const file = path.join(stateDirectory(), name), temporary = `${file}.${randomUUID()}`;
  writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
  renameSync(temporary, file);
}
export function loadState(name) {
  try { return JSON.parse(readFileSync(path.join(stateDirectory(), name), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function storePublishedPdf(buffer, filename) {
  const root = stateDirectory();
  for (const name of readdirSync(root)) {
    if (!/^media-[a-f0-9-]+\.json$/.test(name)) continue;
    const entry = loadState(name);
    if (entry.expiresAt < Date.now()) unlinkSync(path.join(root, name));
  }
  const token = randomUUID();
  saveState(`media-${token}.json`, { bytes: buffer.toString('base64'), filename, expiresAt: Date.now() + 3_600_000 });
  return token;
}
export function readPublishedPdf(token) {
  if (!/^[a-f0-9-]{36}$/.test(token)) return null;
  const entry = loadState(`media-${token}.json`);
  return !entry || entry.expiresAt < Date.now() ? null : { ...entry, buffer: Buffer.from(entry.bytes, 'base64') };
}
