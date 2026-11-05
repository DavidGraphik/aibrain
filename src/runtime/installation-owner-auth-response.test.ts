import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const reply = vi.hoisted(() => ({ status: 200, body: "" }));
vi.mock("node:http", () => ({
  request: (_options: unknown, callback: (response: EventEmitter & { statusCode: number }) => void) => {
    const req = Object.assign(new EventEmitter(), {
      end() {
        const response = Object.assign(new EventEmitter(), { statusCode: reply.status });
        callback(response);
        response.emit("data", reply.body);
        response.emit("end");
        req.emit("close");
      },
      destroy(error: Error) { req.emit("error", error); req.emit("close"); },
    });
    return req;
  },
}));
import { readInstallationOwnerAccess } from "./installation-owner-auth";

afterEach(() => vi.unstubAllEnvs());
describe("owner broker failure classification", () => {
  function authorize() {
    vi.stubEnv("AIBRAIN_CODEX_OWNER_AUTH_SOCKET", "/run/trinalum-owner-auth/broker.sock");
    vi.stubEnv("AIBRAIN_CODEX_AUTH_SCOPE", "installation-owner");
    vi.stubEnv("AIBRAIN_INSTALLATION_OWNER_AUTH_ACK", "trinalum-production");
  }
  it("reports broker unavailability without claiming a foreign account or exposing its body", async () => {
    authorize();
    reply.status = 503;
    reply.body = "private upstream diagnostics must not escape";
    await expect(readInstallationOwnerAccess("trinalum-production", "expected-account"))
      .rejects.toThrow(/^Owner authentication is unavailable\.$/u);
  });
  it("still rejects a successful response for another account", async () => {
    authorize();
    reply.status = 200;
    reply.body = JSON.stringify({ accessToken: "synthetic".repeat(8), chatgptAccountId: "another-account" });
    await expect(readInstallationOwnerAccess("trinalum-production", "expected-account"))
      .rejects.toThrow(/^Owner authentication returned an invalid account\.$/u);
  });
});
