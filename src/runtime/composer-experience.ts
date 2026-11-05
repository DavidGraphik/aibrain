import "server-only";
import type { ComposerExperience } from "@/lib/composer-experience";
import type { RuntimeReasoningEffort } from "@/lib/runtime-status";

export type ResolvedComposerExperience = {
  model: string;
  effort: RuntimeReasoningEffort;
};

const SERVER_COMPOSER_EXPERIENCES: Record<ComposerExperience, ResolvedComposerExperience> = {
  smart: { model: "gpt-6.1-terra", effort: "medium" },
  expert: { model: "gpt-6.1-sol", effort: "medium" },
};

export function resolveServerComposerExperience(
  experience: ComposerExperience,
): ResolvedComposerExperience {
  return resolveInstallationModelPolicy() ?? SERVER_COMPOSER_EXPERIENCES[experience];
}

/** Installation-owned policy; never accepted from a browser or company file. */
export function resolveInstallationModelPolicy(): ResolvedComposerExperience | null {
  const model = process.env.AIBRAIN_SERVER_MODEL?.trim();
  const effort = process.env.AIBRAIN_SERVER_REASONING_EFFORT?.trim();
  if (!model && !effort) return null;
  const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
  if (!model || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(model) || !effort || !efforts.includes(effort)) {
    throw new Error("Invalid installation model policy: configure both server model and reasoning effort.");
  }
  return { model, effort: effort as RuntimeReasoningEffort };
}
