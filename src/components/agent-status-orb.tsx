"use client";

import { ThinkingOrb, type OrbState } from "thinking-orbs";
import type { ActivityKind } from "@/lib/chat-contract";

type AgentStatusKind = ActivityKind | "connecting";

const ORB_STATE_BY_KIND: Record<AgentStatusKind, OrbState> = {
  system: "working",
  reasoning: "solving",
  plan: "shaping",
  command: "working",
  file: "composing",
  tool: "weaving",
  web: "searching",
  agent: "connecting",
  connecting: "connecting",
};

export function orbStateForStatus(kind: AgentStatusKind) {
  return ORB_STATE_BY_KIND[kind];
}

export function AgentStatusOrb({ kind, className }: { kind: AgentStatusKind; className?: string }) {
  return (
    <span className={`agent-status-orb ${className ?? ""}`} aria-hidden="true">
      <ThinkingOrb state={orbStateForStatus(kind)} size={20} />
    </span>
  );
}
