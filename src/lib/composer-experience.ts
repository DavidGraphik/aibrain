export type ComposerExperience = "smart" | "expert";

export function isComposerExperience(value: unknown): value is ComposerExperience {
  return value === "smart" || value === "expert";
}

/** Older clients and saved requests used fast; continue them as Inteligente. */
export function normalizeComposerExperience(value: unknown): ComposerExperience | null {
  if (value === "fast") return "smart";
  return isComposerExperience(value) ? value : null;
}
