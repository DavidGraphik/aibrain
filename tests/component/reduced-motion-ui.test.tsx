// @vitest-environment jsdom

import type { HTMLAttributes, ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "../render-spanish";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface MotionRecord {
  tag: "div" | "span";
  className?: string;
  initial?: unknown;
  animate?: unknown;
  exit?: unknown;
  transition?: unknown;
  style?: unknown;
}

const motionTestState = vi.hoisted(() => ({
  reduce: true,
  records: [] as MotionRecord[],
}));

vi.mock("framer-motion", async () => {
  const React = await import("react");

  type MockMotionProps = HTMLAttributes<HTMLElement> & {
    initial?: unknown;
    animate?: unknown;
    exit?: unknown;
    transition?: unknown;
    onAnimationComplete?: () => void;
  };

  function motionElement(tag: "div" | "span") {
    return React.forwardRef<HTMLElement, MockMotionProps>(function MockMotion(
      {
        initial,
        animate,
        exit,
        transition,
        onAnimationComplete: _onAnimationComplete,
        children,
        ...props
      },
      ref
    ) {
      motionTestState.records.push({
        tag,
        className: props.className,
        initial,
        animate,
        exit,
        transition,
        style: props.style,
      });
      return React.createElement(tag, { ...props, ref }, children);
    });
  }

  return {
    AnimatePresence: ({ children }: { children?: ReactNode }) => children,
    motion: {
      div: motionElement("div"),
      span: motionElement("span"),
    },
    useMotionValue: (initial: number) => {
      let value = initial;
      return {
        get: () => value,
        set: (next: number) => { value = next; },
      };
    },
    useReducedMotion: () => motionTestState.reduce,
  };
});

import {
  ThinkingStep,
  ThinkingStepImage,
  ThinkingStepSource,
  ThinkingStepSources,
  ThinkingSteps,
  ThinkingStepsContent,
  ThinkingStepsHeader,
} from "@/components/ui/thinking-steps";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
} from "@/components/ui/sidebar-menu";
import { Tooltip } from "@/components/ui/tooltip";

function transitionDuration(value: unknown) {
  if (!value || typeof value !== "object" || !("duration" in value)) return undefined;
  return (value as { duration?: unknown }).duration;
}

function exitTransitionDuration(value: unknown) {
  if (!value || typeof value !== "object" || !("transition" in value)) return undefined;
  return transitionDuration((value as { transition?: unknown }).transition);
}

beforeEach(() => {
  motionTestState.reduce = true;
  motionTestState.records.length = 0;
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(200);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(32);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("reduced-motion UI effects", () => {
  it("renders every ThinkingSteps effect in its final state with zero-duration transitions", () => {
    render(
      <ThinkingSteps defaultOpen>
        <ThinkingStepsHeader>Proceso</ThinkingStepsHeader>
        <ThinkingStepsContent>
          <ThinkingStep label="Paso terminado">
            <ThinkingStepSources>
              <ThinkingStepSource delay={0.8}>Fuente</ThinkingStepSource>
            </ThinkingStepSources>
            <ThinkingStepImage src="/preview.png" alt="Vista previa" delay={0.8} />
          </ThinkingStep>
        </ThinkingStepsContent>
      </ThinkingSteps>
    );

    const trigger = screen.getByRole("button", { name: "Proceso" });
    fireEvent.mouseEnter(trigger.parentElement as HTMLElement);

    const effectRecords = motionTestState.records.filter(
      (record) => record.transition !== undefined
    );
    expect(effectRecords.length).toBeGreaterThanOrEqual(6);
    effectRecords.forEach((record) => {
      expect(transitionDuration(record.transition)).toBe(0);
      if (record.initial !== undefined) expect(record.initial).toBe(false);
      if (record.exit !== undefined) expect(exitTransitionDuration(record.exit)).toBe(0);
    });

    const panelId = trigger.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();
    fireEvent.click(trigger);
    expect(document.getElementById(panelId as string)).toHaveAttribute("hidden");
    fireEvent.click(trigger);
    expect(document.getElementById(panelId as string)).not.toHaveAttribute("hidden");
  });

  it("measures a wrapped project button instead of its expanded conversation tree", async () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.sidebar === "menu-item" ? 120 : 32;
    });
    render(<SidebarMenu><SidebarMenuItem>
      <div><SidebarMenuButton isActive>Tests</SidebarMenuButton></div>
      <div>Expanded conversation</div>
    </SidebarMenuItem></SidebarMenu>);
    await waitFor(() => {
      const active = motionTestState.records.filter((record) => record.className?.includes("bg-active")).at(-1);
      expect(active?.animate).toMatchObject({ height: 32 });
    });
  });

  it("snaps sidebar sub-menu and traveling overlays under reduced motion", async () => {
    const { rerender } = render(
      <>
        <SidebarMenuSub open>
          <li>Subelemento</li>
        </SidebarMenuSub>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton isActive>Activo</SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </>
    );

    rerender(
      <>
        <SidebarMenuSub open={false}>
          <li>Subelemento</li>
        </SidebarMenuSub>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton isActive>Activo</SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </>
    );

    const subWrapperRecords = motionTestState.records.filter(
      (record) => record.className?.includes("overflow-hidden")
    );
    expect(subWrapperRecords.length).toBeGreaterThanOrEqual(2);
    expect(transitionDuration(subWrapperRecords.at(-1)?.transition)).toBe(0);

    await waitFor(() => {
      const activeOverlay = motionTestState.records.find((record) =>
        record.className?.includes("bg-active")
      );
      expect(activeOverlay).toBeDefined();
      expect(transitionDuration(activeOverlay?.transition)).toBe(0);
      expect(exitTransitionDuration(activeOverlay?.exit)).toBe(0);
    });
  });

  it("shows tooltips without slide or cursor-follow travel under reduced motion", async () => {
    render(
      <Tooltip content="Ayuda contextual" forceOpen side="right" followCursor="y">
        <button type="button">Control</button>
      </Tooltip>
    );

    await screen.findByText("Ayuda contextual");
    const tooltipRecord = motionTestState.records.find((record) =>
      record.className?.includes("bg-foreground")
    );
    expect(tooltipRecord).toBeDefined();
    expect(tooltipRecord?.initial).toBe(false);
    expect(tooltipRecord?.animate).toEqual({ opacity: 1 });
    expect(tooltipRecord?.transition).toEqual({ duration: 0 });

    motionTestState.records.forEach((record) => {
      expect(record.style).not.toMatchObject({ x: expect.anything() });
      expect(record.style).not.toMatchObject({ y: expect.anything() });
    });
  });

  it("preserves authored timing when reduced motion is not requested", () => {
    motionTestState.reduce = false;

    const { rerender } = render(
      <>
        <ThinkingStepSource delay={0.8}>Fuente</ThinkingStepSource>
        <SidebarMenuSub open>
          <li>Subelemento</li>
        </SidebarMenuSub>
      </>
    );

    rerender(
      <>
        <ThinkingStepSource delay={0.8}>Fuente</ThinkingStepSource>
        <SidebarMenuSub open={false}>
          <li>Subelemento</li>
        </SidebarMenuSub>
      </>
    );

    const source = motionTestState.records.find(
      (record) =>
        record.tag === "span" &&
        typeof record.initial === "object" &&
        record.initial !== null &&
        "scale" in record.initial
    );
    expect(source?.initial).toMatchObject({ opacity: 0, scale: 0.85 });
    expect(source?.transition).toMatchObject({ delay: 0.8 });

    const subWrapper = motionTestState.records
      .filter((record) => record.className?.includes("overflow-hidden"))
      .at(-1);
    expect(transitionDuration(subWrapper?.transition)).toBeGreaterThan(0);
  });
});
