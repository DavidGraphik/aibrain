import type { UiLocale } from "./locale";
import english from "./en.json";
import spanish from "./es.json";
import catalan from "./ca.json";
const catalanMessages: Record<string,string> = catalan;
const spanishMessages: Record<string, string> = spanish;
const messages: Record<string, string> = english;
/** Only explicit interface copy is passed here. Never apply this to customer content. */
export function translate(locale: UiLocale, source: string, values: Record<string, string | number> = {}) {
  const template = locale === "ca" ? catalanMessages[source] ?? source : locale === "es" ? spanishMessages[source] ?? source : messages[source] ?? source;
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) => Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match);
}

export type UiText = (source: string, values?: Record<string, string | number>) => string;
export const spanishUiText: UiText = (source, values) => translate("es", source, values);
