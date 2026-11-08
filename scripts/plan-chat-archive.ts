import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { planThreadArchive } from "../src/workbench/archive-planner";
import { isWorkbenchThread, type WorkbenchThread } from "../src/workbench/types";

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const input = option("--input");
if (!input || !path.isAbsolute(input)) throw new Error("Use --input with an absolute path to a read-only exported thread JSON file.");
const decoded: unknown = JSON.parse(await readFile(input, "utf8"));
const values = Array.isArray(decoded) ? decoded : decoded && typeof decoded === "object" && "threads" in decoded ? (decoded as { threads: unknown }).threads : null;
if (!Array.isArray(values) || !values.every(isWorkbenchThread)) throw new Error("Input must be an array of complete WorkbenchThread records or {threads:[...]}.");
const plan = planThreadArchive(values as WorkbenchThread[], {
  recentDays: Number(option("--recent-days") ?? 30),
  targetArchiveRatio: Number(option("--target-ratio") ?? 0.9),
});
const serialized = `${JSON.stringify(plan, null, 2)}\n`;
const output = option("--output");
if (output) {
  if (!path.isAbsolute(output)) throw new Error("--output must be an absolute path.");
  await writeFile(output, serialized, { flag: "wx", mode: 0o600 });
} else process.stdout.write(serialized);
