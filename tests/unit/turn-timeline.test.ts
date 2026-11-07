import { describe, expect, it } from "vitest";
import orderGolden from "../golden/turn-activity-order.json";
import { turnActivityScenarios } from "../fixtures/turn-activity-scenarios";
import {
  buildTurnTimeline,
  formatWorkDuration,
  turnDurationMs,
} from "@/ui/turn-timeline";

describe("turn timeline golden fixtures", () => {
  it.each(["multipleTools", "errorRecovery"] as const)(
    "preserves the real cross-kind event order for %s",
    (scenarioName) => {
      const scenario = turnActivityScenarios[scenarioName];
      expect(buildTurnTimeline(scenario.activity, scenario.toolResults ?? []).map((entry) => entry.key))
        .toEqual(orderGolden[scenarioName]);
    },
  );

  it("uses measured duration and the legacy server telemetry fallback", () => {
    expect(turnDurationMs(turnActivityScenarios.errorRecovery)).toBe(92_000);
    expect(formatWorkDuration(692_000)).toBe("11m 32s");
    expect(turnDurationMs({
      activity: [{
        id: "runtime-performance",
        kind: "system",
        label: "Rendiment del torn",
        detail: "Primer text 30508 ms · Total 45918 ms · Worker calent",
        status: "complete",
      }],
    })).toBe(45_918);
  });
});
