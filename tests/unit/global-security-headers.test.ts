import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

describe("global security headers", () => {
  it("keeps every route protected from framing while PDF previews use a client-side private blob", async () => {
    const rules = await nextConfig.headers?.();
    const globalHeaders = rules?.find((rule) => rule.source === "/:path*")?.headers ?? [];
    const header = (key: string) => globalHeaders.find((candidate) => candidate.key === key)?.value;

    expect(header("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(header("Content-Security-Policy")).toContain("frame-src 'self' blob:");
    expect(header("Content-Security-Policy")).toContain("object-src 'none'");
    expect(header("X-Frame-Options")).toBe("DENY");
  });
});
