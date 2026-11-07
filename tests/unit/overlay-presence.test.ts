import { describe, expect, it } from "vitest";
import { overlayPresenceMotion } from "@/ui/overlay-presence";

describe("overlay presence motion", () => {
  it.each([
    ["right", { x: "100%" }, { x: 0 }],
    ["top", { y: -12, scale: 0.985 }, { y: 0, scale: 1 }],
    ["center", { y: 10, scale: 0.985 }, { y: 0, scale: 1 }],
  ] as const)("returns the %s surface along the exact path it entered", (origin, hidden, visible) => {
    const motion = overlayPresenceMotion(origin, false);
    expect(motion.surface.initial).toEqual(hidden);
    expect(motion.surface.animate).toEqual(visible);
    expect(motion.surface.exit).toEqual(hidden);
    expect(motion.surface.transition).toMatchObject({ type: "spring", bounce: 0 });
  });

  it("reduces every origin to a short opacity change without travel", () => {
    for (const origin of ["right", "top", "center"] as const) {
      const motion = overlayPresenceMotion(origin, true);
      expect(motion.layer).toMatchObject({
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
        transition: { duration: 0.08, ease: "linear" },
      });
      expect(motion.surface).toMatchObject({
        initial: { opacity: 1 },
        animate: { opacity: 1 },
        exit: { opacity: 1 },
        transition: { duration: 0.08, ease: "linear" },
      });
    }
  });
});
