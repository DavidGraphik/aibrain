import { describe, expect, it } from "vitest";
import { readProcessIncarnation } from "@/storage/process-incarnation";

const boot = "12345678-1234-1234-1234-123456789abc";
const namespace = async () => ({ dev: 4, ino: 100 });
const procStat = `7 (worker (with spaces)) S ${Array(18).fill("0").join(" ")} 900 0 0`;
const read = async (file: string) => file.endsWith("boot_id") ? boot : procStat;

describe("Linux process incarnation", () => {
  it("uses boot, namespace and start ticks, tolerating spaces and parentheses in comm", async () => {
    expect(await readProcessIncarnation(7, "linux", read, namespace))
      .toBe(`linux:${boot}:4:100:900`);
  });

  it("distinguishes reused PID, a different namespace and a different boot", async () => {
    const first = await readProcessIncarnation(7, "linux", read, namespace);
    const restarted = await readProcessIncarnation(7, "linux", async (file) =>
      file.endsWith("boot_id") ? boot : procStat.replace("900", "901"), namespace);
    const otherNamespace = await readProcessIncarnation(7, "linux", read, async () => ({ dev: 4, ino: 101 }));
    const rebooted = await readProcessIncarnation(7, "linux", async (file) =>
      file.endsWith("boot_id") ? boot.replace("12345678", "87654321") : procStat, namespace);
    expect(new Set([first, restarted, otherNamespace, rebooted]).size).toBe(4);
  });

  it("does not invent an identity on unsupported platforms, denied procfs or malformed data", async () => {
    expect(await readProcessIncarnation(7, "darwin", read, namespace)).toBeNull();
    expect(await readProcessIncarnation(7, "linux", async () => { throw new Error("EACCES"); }, namespace)).toBeNull();
    expect(await readProcessIncarnation(7, "linux", async () => "bad", namespace)).toBeNull();
  });
});
