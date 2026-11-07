import { describe, expect, it } from "vitest";
import { parseSupportRequestInput } from "@/support/contracts";

describe("support request contract", () => {
  it("keeps only bounded context without query strings", () => {
    expect(parseSupportRequestInput({ kind: "bug", description: "  No carga  ", context: { pathname: "/workspace", projectId: null, threadId: null, viewport: "desktop" } })).toEqual({ kind: "bug", description: "No carga", context: { pathname: "/workspace", projectId: null, threadId: null, viewport: "desktop" } });
    expect(parseSupportRequestInput({ kind: "help", description: "Ayuda", context: { pathname: "/workspace?token=secret", projectId: null, threadId: null, viewport: "mobile" } })).toBeNull();
  });

  it("rejects unknown fields and unsafe identifiers", () => {
    expect(parseSupportRequestInput({ kind: "request", description: "Añadir algo", context: { pathname: "/", projectId: "other-user", threadId: null, viewport: "desktop" } })).toBeNull();
    expect(parseSupportRequestInput({ kind: "bug", description: "x", secret: "no", context: { pathname: "/", projectId: null, threadId: null, viewport: "desktop" } })).toBeNull();
  });
});
