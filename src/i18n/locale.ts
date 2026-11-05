export const UI_LOCALES = ["en", "es", "ca"] as const;
export type UiLocale = typeof UI_LOCALES[number];
export const DEFAULT_UI_LOCALE: UiLocale = "en";
export function isUiLocale(value: unknown): value is UiLocale { return value === "en" || value === "es" || value === "ca"; }
