import { expect, it, vi } from "vitest";
import { BackgroundMaintenance } from "./background-maintenance";

it("admits scheduling without waiting for maintenance, keeps one scan and drains on shutdown", async () => {
  let release!: (value: string) => void;
  const execute = vi.fn(() => new Promise<string>(resolve => { release = resolve; }));
  const report = vi.fn();
  const lane = new BackgroundMaintenance(execute, report, vi.fn());
  expect(lane.start(["user-a"])).toBe(true);
  expect(lane.start(["user-b"])).toBe(false);
  await Promise.resolve();
  expect(execute).toHaveBeenCalledOnce();
  let stopped = false;
  const stop = lane.stop().then(() => { stopped = true; });
  await Promise.resolve(); expect(stopped).toBe(false);
  release("finished"); await stop;
  expect(report).toHaveBeenCalledWith("finished");
  expect(lane.start(["user-a"])).toBe(false);
});

it("a failed extraction is reported and may be retried on a later scheduling tick", async () => {
  const error = vi.fn();
  const execute = vi.fn().mockRejectedValueOnce(new Error("private provider detail")).mockResolvedValueOnce("ok");
  const report = vi.fn();
  const lane = new BackgroundMaintenance(execute, report, error);
  lane.start(null);
  await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
  expect(lane.start(null)).toBe(true);
  await lane.stop();
  expect(report).toHaveBeenCalledWith("ok");
  expect(error).toHaveBeenCalledWith();
});
