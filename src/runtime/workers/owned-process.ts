import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

/** Only pass ownsProcessGroup for a process launched detached by this owner. */
export async function stopOwnedWorkerProcess(
  child: ChildProcess,
  ownsProcessGroup: boolean,
  graceMs = 1_000,
  finishMs = 5_000,
) {
  const pid = child.pid;
  if (!pid) return; // spawn failure: there is no process to own
  const group = ownsProcessGroup && process.platform !== "win32";
  const alive = () => {
    if (!group) return child.exitCode === null && child.signalCode === null;
    try { process.kill(-pid, 0); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  };
  const signal = (value: NodeJS.Signals) => {
    try {
      if (group) process.kill(-pid, value);
      else child.kill(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  if (!alive()) return;
  signal("SIGTERM");
  const graceDeadline = performance.now() + graceMs;
  while (alive() && performance.now() < graceDeadline) await delay(10);
  if (alive()) signal("SIGKILL");
  const finishDeadline = performance.now() + finishMs;
  while (alive() && performance.now() < finishDeadline) await delay(10);
  if (alive()) throw new Error("Worker process cleanup did not complete in time.");
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
}
