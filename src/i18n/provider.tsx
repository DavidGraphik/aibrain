"use client";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { DEFAULT_UI_LOCALE, type UiLocale } from "./locale";
import { translate } from "./messages";
const LocaleContext = createContext<UiLocale>(DEFAULT_UI_LOCALE);
export function UiLocaleProvider({ locale, children }: { locale: UiLocale; children: ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}
export function useUiLocale() { return useContext(LocaleContext); }
export function useUiText() {
  const locale = useUiLocale();
  return useMemo(() => (source: string, values?: Record<string, string | number>) => translate(locale, source, values), [locale]);
}
