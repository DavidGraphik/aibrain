"use client";

import type { MotionProps } from "framer-motion";
import { motion, useIsPresent, useReducedMotion } from "framer-motion";
import type { ComponentProps, ReactNode, Ref } from "react";
import { spring } from "@/lib/springs";

export type OverlayMotionOrigin = "top" | "center" | "right";
export type OverlaySurfaceMotion = Pick<MotionProps, "initial" | "animate" | "exit" | "transition">;
type OverlayRootProps = Omit<
  ComponentProps<typeof motion.div>,
  "animate" | "children" | "className" | "exit" | "initial" | "ref" | "transition"
>;

const reducedTransition = { duration: 0.08, ease: "linear" as const };
const fadeTransition = { duration: spring.moderate.duration, ease: [0.4, 0, 0.2, 1] as const };
const surfaceTransition = {
  type: "spring" as const,
  duration: spring.moderate.duration,
  bounce: 0,
};

function surfaceTargets(origin: OverlayMotionOrigin, reduceMotion: boolean) {
  if (reduceMotion) return {
    hidden: { opacity: 1 },
    visible: { opacity: 1 },
  };
  if (origin === "right") return {
    hidden: { x: "100%" },
    visible: { x: 0 },
  };
  if (origin === "top") return {
    hidden: { y: -12, scale: 0.985 },
    visible: { y: 0, scale: 1 },
  };
  return {
    hidden: { y: 10, scale: 0.985 },
    visible: { y: 0, scale: 1 },
  };
}

export function overlayPresenceMotion(origin: OverlayMotionOrigin, reduceMotion: boolean) {
  const targets = surfaceTargets(origin, reduceMotion);
  return {
    layer: {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 },
      transition: reduceMotion ? reducedTransition : fadeTransition,
    } satisfies OverlaySurfaceMotion,
    surface: {
      initial: targets.hidden,
      animate: targets.visible,
      exit: targets.hidden,
      transition: reduceMotion ? reducedTransition : surfaceTransition,
    } satisfies OverlaySurfaceMotion,
  };
}

export function OverlayPresenceLayer({
  origin,
  className,
  rootRef,
  children,
  ...rootProps
}: {
  origin: OverlayMotionOrigin;
  className: string;
  rootRef?: Ref<HTMLDivElement>;
  children: (surfaceMotion: OverlaySurfaceMotion) => ReactNode;
} & OverlayRootProps) {
  const reduceMotion = useReducedMotion() ?? false;
  const isPresent = useIsPresent();
  const presenceMotion = overlayPresenceMotion(origin, reduceMotion);

  return (
    <motion.div
      {...rootProps}
      ref={rootRef}
      data-overlay-presence={isPresent ? "present" : "exiting"}
      aria-hidden={isPresent ? undefined : true}
      inert={isPresent ? undefined : true}
      className={className}
      style={isPresent ? undefined : { pointerEvents: "none" }}
      {...presenceMotion.layer}
    >
      {children(presenceMotion.surface)}
    </motion.div>
  );
}
