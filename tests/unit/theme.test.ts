import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isThemePreference, resolveTheme } from "@/ui/theme";

describe("theme contract", () => {
  it("uses Codex neutral surfaces consistently in explicit and system dark preferences", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    expect(css).toContain("--canvas: #ffffff;");
    expect(css).toContain("--sidebar: #f8f8f8;");
    expect(css.match(/--canvas: #181818;/g)).toHaveLength(2);
    expect(css.match(/--sidebar: #212121;/g)).toHaveLength(2);
    expect(css.match(/--composer-surface: #363636;/g)).toHaveLength(2);
    expect(css.match(/--text: #ececec;/g)).toHaveLength(2);
    expect(css.match(/--user-message-text: var\(--text\);/g)).toHaveLength(2);
    expect(css.match(/--send-button: var\(--mineral-white\);/g)).toHaveLength(2);
  });

  it("resolves the system preference deterministically", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
  });

  it("rejects unknown persisted values", () => {
    expect(isThemePreference("dark")).toBe(true);
    expect(isThemePreference("sepia")).toBe(false);
  });
});
