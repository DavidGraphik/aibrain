import { describe, expect, it } from "vitest";
import { installationOwnerAuthSocket } from "./installation-owner-auth";

describe("installation owner auth authorization", () => {
  const environment = {
    AIBRAIN_CODEX_OWNER_AUTH_SOCKET: "/run/trinalum-owner-auth/broker.sock",
    AIBRAIN_CODEX_AUTH_SCOPE: "installation-owner",
    AIBRAIN_INSTALLATION_OWNER_AUTH_ACK: "trinalum-production",
  };
  it("requires the explicit owner authorization and fixed private socket", () => {
    expect(installationOwnerAuthSocket("trinalum-production", environment)).toBe(environment.AIBRAIN_CODEX_OWNER_AUTH_SOCKET);
    expect(installationOwnerAuthSocket("other", {})).toBeNull();
    expect(() => installationOwnerAuthSocket("other", environment)).toThrow(/not authorized/u);
    expect(() => installationOwnerAuthSocket("trinalum-production", { ...environment, AIBRAIN_CODEX_AUTH_SCOPE: "per-user" })).toThrow(/not authorized/u);
    expect(() => installationOwnerAuthSocket("trinalum-production", { ...environment, AIBRAIN_CODEX_OWNER_AUTH_SOCKET: "/tmp/foreign.sock" })).toThrow(/not authorized/u);
  });
});
