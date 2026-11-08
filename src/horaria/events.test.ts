import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/config/installation", () => ({ loadInstallationConfig: vi.fn(async () => ({ installationId: "company", paths: { usersRoot: "/private/users" } })) }));
vi.mock("@/horaria/private-transport", () => ({ privateHorariaRequest: vi.fn() }));
vi.mock("@/horaria/client", async importOriginal => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, loadHorariaConfig: vi.fn(), callHoraria: vi.fn(async () => ({})) };
});
vi.mock("@/auth/local-user-store", () => ({ FileLocalUserStore: class { read = vi.fn(async () => ({ enabled: enabledUser })); } }));
vi.mock("@/operations/server-logger", () => ({ operationalLogger: { error: vi.fn() } }));
vi.mock("@/horaria/codex", () => ({ runHorariaCodex: vi.fn() }));
import { loadHorariaConfig, callHoraria, bridgeToken, type HorariaConfig } from "./client";
import { privateHorariaRequest } from "./private-transport";
import { POST as webhook } from "@/app/api/horaria-events/[...path]/route";
import { POST as codex } from "@/app/api/horaria-codex/route";
import { runHorariaCodex } from "./codex";
let enabledUser = true;
const config: HorariaConfig = { installationId: "company", baseUrl: "http://horaria:3210", secret: "test-only-secret-longer-than-32-characters", users: { owner: { employeeId: 7, backgroundOperations: [] } }, eventsEnabled: true, eventActorId: "owner" };
beforeEach(() => { vi.clearAllMocks(); enabledUser = true; vi.mocked(loadHorariaConfig).mockResolvedValue(config); });
describe("public WhatsApp proxy", () => {
  it("preserves signed provider bytes and derives the actor from private configuration", async () => {
    vi.mocked(privateHorariaRequest).mockResolvedValue(new Response("OK"));
    const body = '{ "actorId":"attacker", "employeeId":999 }';
    const response = await webhook(new Request("https://example.test/api/horaria-events/webhook", { method: "POST", body, headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=test" } }), { params: Promise.resolve({ path: ["webhook"] }) });
    expect(response.status).toBe(200);
    const [, target, options] = vi.mocked(privateHorariaRequest).mock.calls[0];
    expect(target).toBe("/api/whatsapp/webhook");
    expect(Buffer.from(options.body as Uint8Array).toString()).toBe(body);
    const headers = new Headers(options.headers);
    expect(headers.get("x-hub-signature-256")).toBe("sha256=test");
    const token = headers.get("x-aibrain-authorization")!;
    expect(JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString())).toMatchObject({ kind: "event", installationId: "company", actorId: "owner", employeeId: 7 });
  });
  it("does not contact the service while disabled or without an operator binding", async () => {
    for (const c of [{ ...config, eventsEnabled: false }, { ...config, eventActorId: undefined }]) {
      vi.mocked(loadHorariaConfig).mockResolvedValue(c);
      const response = await webhook(new Request("https://example.test/api/horaria-events/webhook", { method: "POST", body: "{}" }), { params: Promise.resolve({ path: ["webhook"] }) });
      expect([404, 503]).toContain(response.status);
    }
    expect(privateHorariaRequest).not.toHaveBeenCalled();
  });
});
describe("WhatsApp pre-effect authorization", () => {
  const request = () => {
    const body = Buffer.from('{"authorizationOnly":true}');
    const token = bridgeToken(config, { kind: "user", source: "whatsapp", actorId: "owner", employeeId: 7, method: "POST", target: "/api/horaria-codex", contentType: "application/json", body });
    return new Request("http://app/api/horaria-codex", { method: "POST", body, headers: { "x-aibrain-authorization": token } });
  };
  it("rechecks the enabled account and live manager without starting AI", async () => {
    const response = await codex(request());
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ authorized: true });
    expect(callHoraria).toHaveBeenCalled(); expect(runHorariaCodex).not.toHaveBeenCalled();
  });
  it("refuses revoked accounts, operator bindings and disabled reception without AI or business effects", async () => {
    enabledUser = false; expect((await codex(request())).status).toBe(403);
    expect(callHoraria).not.toHaveBeenCalled();
    enabledUser = true; vi.mocked(loadHorariaConfig).mockResolvedValue({ ...config, eventsEnabled: false });
    expect((await codex(request())).status).toBe(503);
    expect(callHoraria).not.toHaveBeenCalled(); expect(runHorariaCodex).not.toHaveBeenCalled();
  });
});
