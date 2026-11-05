import type { InstallationConfig } from "@/config/installation-schema";

export const IMPECCABLE_SKILL = { id: "impeccable", label: "Impeccable · Diseño y UX" };
export const DESIGN_COPY_SKILLS = [
  IMPECCABLE_SKILL,
  { id: "presentation-craft", label: "Presentaciones: narrativa y revisión" },
  { id: "emil-design-eng", label: "Interacciones y movimiento" },
  { id: "design-taste-frontend", label: "Criterio visual" },
  { id: "redesign-existing-projects", label: "Refinamiento de interfaces" },
  { id: "ux-writing", label: "Textos de interfaz" },
  { id: "human-writing", label: "Redacción natural" },
  { id: "ogilvy-copywriting", label: "Copy comercial" },
];

/** Product defaults; effective catalog denials still override installation grants. */
export function managedSkillsForInstallation(config: Readonly<InstallationConfig>) {
  const configured = config.catalog?.graphikAIManagedSkills ?? [];
  return [...configured, ...DESIGN_COPY_SKILLS.filter(({ id }) => !configured.some((skill) => skill.id === id))];
}
