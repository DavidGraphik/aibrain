import { readFile, stat } from "node:fs/promises";

// A PID is only an address. Linux may reuse it, especially PID 7 after a
// container restart. Bind it to a boot, PID namespace and kernel start tick.
// Missing /proc access is deliberately not evidence that an owner is dead.
export async function readProcessIncarnation(
  processId: number,
  platform: NodeJS.Platform = process.platform,
  readText: (file: string) => Promise<string> = (file) => readFile(file, "utf8"),
  inspect: (file: string) => Promise<{ dev: number; ino: number }> = stat,
): Promise<string | null> {
  if (platform !== "linux") return null;
  try {
    const [boot, processStat, namespace] = await Promise.all([
      readText("/proc/sys/kernel/random/boot_id"),
      readText(`/proc/${processId}/stat`),
      inspect(`/proc/${processId}/ns/pid`),
    ]);
    // comm (field 2) can contain spaces and parentheses, so split after its
    // last closing parenthesis. starttime is field 22 (index 19 thereafter).
    const close = processStat.lastIndexOf(")");
    const startTicks = processStat.slice(close + 1).trim().split(/\s+/)[19];
    const bootId = boot.trim();
    if (close < 0 || !/^[0-9a-f-]{36}$/.test(bootId) || !/^\d+$/.test(startTicks ?? "")) {
      return null;
    }
    return `linux:${bootId}:${namespace.dev}:${namespace.ino}:${startTicks}`;
  } catch {
    return null;
  }
}
