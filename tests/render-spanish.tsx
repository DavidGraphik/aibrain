import { render as testingRender, type RenderOptions } from "@testing-library/react";
import type { ReactNode } from "react";
import { UiLocaleProvider } from "@/i18n/provider";
export * from "@testing-library/react";
/** Existing behavior fixtures explicitly choose Spanish; product default remains English. */
export function render(ui: ReactNode, options?: RenderOptions) {
  const wrap = (node: ReactNode) => <UiLocaleProvider locale="es">{node}</UiLocaleProvider>;
  const result = testingRender(wrap(ui), options);
  return { ...result, rerender: (node: ReactNode) => result.rerender(wrap(node)) };
}
