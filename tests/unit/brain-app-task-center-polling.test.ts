import { describe, expect, it } from "vitest";
import { createTaskCenterResponseGate } from "@/components/brain-app";

describe("task center polling response gate", () => {
  it("rejects a late poll once a newer mutation has started", () => {
    const gate = createTaskCenterResponseGate();
    const poll = gate.beginPoll();
    expect(poll).not.toBeNull();
    expect(gate.isCurrent(poll!)).toBe(true);

    const mutation = gate.beginMutation();
    expect(gate.isCurrent(poll!)).toBe(false);
    expect(gate.isCurrent(mutation)).toBe(true);
    expect(gate.beginPoll()).toBeNull();

    expect(gate.finishMutation()).toBe(0);
    gate.finishPoll(poll!);
    const nextPoll = gate.beginPoll();
    expect(nextPoll).not.toBeNull();
    expect(gate.isCurrent(mutation)).toBe(false);
    expect(gate.isCurrent(nextPoll!)).toBe(true);
  });

  it("admits one poll until its response or failure settles", () => {
    const gate = createTaskCenterResponseGate();
    const first = gate.beginPoll()!;
    for (let index = 0; index < 12; index += 1) expect(gate.beginPoll()).toBeNull();
    gate.finishPoll(first);
    const next = gate.beginPoll()!;
    expect(next).not.toBeNull();
    // A stale completion must not clear the new request.
    gate.finishPoll(first);
    expect(gate.beginPoll()).toBeNull();
    gate.finishPoll(next);
    expect(gate.beginPoll()).not.toBeNull();
  });

  it("keeps polling paused until every overlapping mutation has settled", () => {
    const gate = createTaskCenterResponseGate();
    const first = gate.beginMutation();
    const second = gate.beginMutation();

    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
    expect(gate.hasMutation()).toBe(true);
    expect(gate.finishMutation()).toBe(1);
    expect(gate.beginPoll()).toBeNull();
    expect(gate.finishMutation()).toBe(0);
    expect(gate.hasMutation()).toBe(false);
    expect(gate.beginPoll()).not.toBeNull();
  });
});
