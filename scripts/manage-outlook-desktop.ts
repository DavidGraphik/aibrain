/** Trusted server operator only. Run with register-server-only-stub.mjs + tsx. */
import { open, realpath, lstat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadInstallationConfig } from "../src/config/installation";
import { FileLocalUserStore } from "../src/auth/local-user-store";
import { USER_ID_PATTERN } from "../src/connectors/contracts";
import { readRegularFileWithin } from "../src/security/safe-file";
import { desktopRecord, OutlookDesktopError } from "../src/connectors/outlook-desktop-contracts";
import { configureOutlookArchiveForIdentity, createOutlookDesktopEnrollment, readOutlookDesktopStatusForIdentity, revokeOutlookDesktopIdentity } from "../src/connectors/outlook-desktop-service";
export function parseOutlookDesktopOperatorArgs(args: string[]) {
  const values: Record<string, string> = {}, storeIds: string[] = [];
  const keys = ["--action", "--user-id", "--inventory", "--email", "--store-id", "--output", "--server-url", "--quota-bytes"];
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!keys.includes(flag) || typeof value !== "string" || !value || value.startsWith("--") || /[\0\r\n]/.test(value) || flag !== "--store-id" && values[flag]) throw new OutlookDesktopError("OUTLOOK_DESKTOP_CLI_ARGUMENTS_INVALID");
    if (flag === "--store-id") storeIds.push(value); else values[flag] = value;
  }
  if (!["enroll", "revoke", "status", "archive-configure"].includes(values["--action"]) || !USER_ID_PATTERN.test(values["--user-id"] ?? "")) throw new OutlookDesktopError("OUTLOOK_DESKTOP_CLI_ARGUMENTS_INVALID");
  if (values["--action"] === "archive-configure" ? !/^\d+$/.test(values["--quota-bytes"] ?? "") || !Number.isSafeInteger(Number(values["--quota-bytes"])) || Number(values["--quota-bytes"]) > 20 * 1024 ** 3 : values["--quota-bytes"] !== undefined) throw new OutlookDesktopError("OUTLOOK_DESKTOP_CLI_ARGUMENTS_INVALID");
  if (values["--action"] === "enroll" && (!values["--inventory"] || !values["--output"] || !values["--email"] || !storeIds.length || new Set(storeIds).size !== storeIds.length)) throw new OutlookDesktopError("OUTLOOK_DESKTOP_CLI_ARGUMENTS_INVALID");
  for (const flag of ["--inventory", "--output"]) if (values[flag] && !path.isAbsolute(values[flag])) throw new OutlookDesktopError("OUTLOOK_DESKTOP_CLI_PATH_INVALID");
  if (values["--action"] !== "enroll" && (storeIds.length || ["--inventory", "--output", "--email", "--server-url"].some(key => values[key]))) throw new OutlookDesktopError("OUTLOOK_DESKTOP_CLI_ARGUMENTS_INVALID");
  return { action: values["--action"], userId: values["--user-id"], inventory: values["--inventory"], output: values["--output"], email: values["--email"]?.toLowerCase(), serverUrl: values["--server-url"], storeIds, quotaBytes: values["--quota-bytes"] === undefined ? undefined : Number(values["--quota-bytes"]) };
}
export function desktopMachineFromInventory(inventory: unknown, email: string, storeIds: string[]) {
  if (!desktopRecord(inventory) || inventory.schema !== 1 || !Array.isArray(inventory.accounts) || !Array.isArray(inventory.stores) || inventory.accounts.length > 100 || inventory.stores.length > 100 || !inventory.accounts.some(account => desktopRecord(account) && typeof account.email === "string" && account.email.toLowerCase() === email) || !storeIds.every(id => (inventory.stores as unknown[]).some(store => desktopRecord(store) && store.storeId === id))) throw new OutlookDesktopError("OUTLOOK_DESKTOP_INVENTORY_INVALID");
  return { sid: inventory.sid as string, computer: inventory.computer as string, email, storeIds };
}
async function privateOutput(file: string) {
  const directory = path.dirname(file), canonical = await realpath(directory), metadata = await lstat(directory);
  if (directory !== canonical || metadata.isSymbolicLink() || !metadata.isDirectory() || (metadata.mode & 0o077) !== 0 || /[\\/](?:Mobile Documents|Desktop|Documents)(?:[\\/]|$)/.test(canonical)) throw new OutlookDesktopError("OUTLOOK_DESKTOP_OUTPUT_UNSAFE");
  return open(file, "wx", 0o600);
}
export async function manageOutlookDesktop(args: string[]) {
  const options = parseOutlookDesktopOperatorArgs(args), config = await loadInstallationConfig(), identity = { config, userId: options.userId };
  if (options.action === "revoke") return revokeOutlookDesktopIdentity(identity);
  if (options.action === "status") return readOutlookDesktopStatusForIdentity(identity);
  if (options.action === "archive-configure") return configureOutlookArchiveForIdentity(identity, options.quotaBytes!);
  const user = await new FileLocalUserStore(config.paths.usersRoot).read(options.userId); if (!user?.enabled || options.email !== user.email) throw new OutlookDesktopError("OUTLOOK_DESKTOP_IDENTITY_INVALID", 403);
  const contents = await readRegularFileWithin(path.dirname(options.inventory), path.basename(options.inventory), 1024 * 1024);
  let inventory: unknown; try { inventory = JSON.parse(contents.toString("utf8")); } catch { throw new OutlookDesktopError("OUTLOOK_DESKTOP_INVENTORY_INVALID"); }
  const machine = desktopMachineFromInventory(inventory, user.email, options.storeIds);
  // Open exclusively before creating the code, so an existing file never causes
  // an accidental replacement or a secret on stdout. Empty failed files are safe.
  const file = await privateOutput(options.output);
  try { const enrollment = await createOutlookDesktopEnrollment(identity, machine, options.serverUrl ?? config.publicUrl); await file.writeFile(`${JSON.stringify(enrollment, null, 2)}\n`); await file.sync(); } finally { await file.close(); }
  return { status: "enrollment_file_created", output: options.output, userId: options.userId };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void manageOutlookDesktop(process.argv.slice(2)).then(result => { process.stdout.write(`${JSON.stringify(result)}\n`); }).catch(error => { process.stderr.write(`${error instanceof OutlookDesktopError ? error.code : "OUTLOOK_DESKTOP_OPERATOR_FAILED"}\n`); process.exitCode = 1; });
}
