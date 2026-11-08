import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ owner: "10000000-0000-4000-8000-000000000001", target: "10000000-0000-4000-8000-000000000002",
  policy: {} as Record<string, unknown>, binding: {} as Record<string, unknown> | null, enabled: true, initial: false,
  own: false, profile: "profile", permissions: "permissions", unsafe: "", ownerCheck: vi.fn(), snapshot: vi.fn(), provider: vi.fn(), session: vi.fn(), installed: "g03-production" }));
vi.mock("@/auth/private-owner-identity-provider", async importOriginal => ({
  ...await importOriginal<typeof import("@/auth/private-owner-identity-provider")>(), assertPrivateOwnerSupportSponsor: state.ownerCheck,
}));
vi.mock("@/runtime/server-model-auth", async importOriginal => ({ ...await importOriginal<typeof import("./server-model-auth")>(), ModelAuthUnavailableError: class extends Error { code="MODEL_AUTH_UNAVAILABLE"; },
  assertOwnPersonalModelTest: async () => { if (!state.own) throw Error("not owner"); } }));
vi.mock("@/runtime/personal-auth-provider", () => ({ userAccessAuthProvider: state.provider }));
vi.mock("@/security/safe-file", () => ({ readRegularFileWithin: async (_root: string, p: string) => Buffer.from(p.includes("user.json") ? state.profile : state.permissions) }));
vi.mock("@/auth/auth-context", () => ({ createLocalSessionContext: async () => ({ installation: { installationId: state.installed, paths:{dataRoot:"/synthetic"}},
  users: { read: async () => ({ enabled:state.enabled }), hasInitialPasswordMarker: async () => state.initial },
  sessions: { activeSupportBindingByHash: state.session } }) }));
vi.mock("node:fs/promises", () => ({ realpath: async () => "/etc/aibrain/personal-test-support.json",
  lstat: async (_p: string, options?: unknown) => options ? info() : ({isFile:()=>true,isSymbolicLink:()=>state.unsafe==="symlink"}),
  open: async () => ({stat:async()=>info(),readFile:async()=>Buffer.from(JSON.stringify(state.policy)),close:async()=>{}}) }));
function info(){return {isFile:()=>true,uid:state.unsafe==="uid"?1n:0n,gid:BigInt(process.getegid?.()??0),mode:state.unsafe==="mode"?0o100660n:0o100640n,nlink:state.unsafe==="hardlink"?2n:1n,size:BigInt(Buffer.byteLength(JSON.stringify(state.policy))),ino:1n,dev:1n,mtimeNs:1n,ctimeNs:1n};}
import { createHash } from "node:crypto";
import { supportModelSponsor, supportModelPermissionsDigest, parseSupportModelQaPolicy, personalQaAuthProvider, assertSponsoredModelRpc, SPONSORED_MODEL_CONFIG_OVERRIDES } from "./support-model-qa";
const identity = () => ({installationId:"g03-production",userId:state.target});
afterEach(() => vi.unstubAllEnvs());
beforeEach(()=>{
 vi.stubEnv("AIBRAIN_AUTH_MODE", "private-owner"); vi.stubEnv("AIBRAIN_MODEL_AUTH", "personal-test");
 vi.stubEnv("AIBRAIN_CODEX_AUTH_SCOPE", "per-user"); vi.stubEnv("AIBRAIN_CODEX_TRANSPORT", "stdio");
 vi.stubEnv("AIBRAIN_CODEX_USER_ACCESS_SOCKET_ROOT", "/synthetic/per-user-broker");
 for (const name of ["AIBRAIN_SHARED_CODEX_AUTH_SOURCE", "AIBRAIN_CODEX_OWNER_AUTH_SOCKET", "AIBRAIN_INSTALLATION_OWNER_AUTH_ACK", "OPENAI_API_KEY", "CODEX_API_KEY"]) vi.stubEnv(name, "");
 state.unsafe="";state.installed="g03-production";state.enabled=true;state.initial=false;state.own=false;state.profile="profile";state.permissions="permissions";
 state.policy={schemaVersion:1,installationId:"g03-production",sponsorUserId:state.owner,sponsorEmail:"david@example.invalid",createdAt:Date.now()-1000,expiresAt:Date.now()+60000,
 targets:[{userId:state.target,sessionIdHash:"a".repeat(64),profileSha256:createHash("sha256").update(state.profile).digest("hex"),permissionsSha256:supportModelPermissionsDigest(Buffer.from(state.permissions),Buffer.from(state.permissions))}]};
 state.binding={support:{actorUserId:state.owner,actorEmail:"david@example.invalid"}};
 state.session.mockReset().mockImplementation(async()=>state.binding);state.ownerCheck.mockReset().mockResolvedValue(undefined);
 state.snapshot.mockReset().mockResolvedValue({accessToken:"synthetic",chatgptAccountId:"sponsor-account",chatgptPlanType:"pro"});state.provider.mockReset().mockReturnValue(state.snapshot);
});
describe("root-pinned model-only support sponsorship",()=>{
 it("selects sponsor model socket while retaining the complete target input unchanged",async()=>{
  const target=identity();const before=JSON.stringify(target);const auth=personalQaAuthProvider(target);await auth();
  expect(JSON.stringify(target)).toBe(before);expect(state.provider).toHaveBeenCalledWith({installationId:"g03-production",userId:state.owner});
  expect(state.session).toHaveBeenCalledWith("g03-production",state.target,"a".repeat(64));expect(state.ownerCheck).toHaveBeenCalledTimes(2);
 });
 it.each(["missing-session","forged-actor","forged-email","disabled","initial","foreign","profile-drift","acl-drift","owner-expired"])("fails closed: %s",async reason=>{
  if(reason==="missing-session")state.binding=null;
  if(reason==="forged-actor")(state.binding!.support as Record<string,unknown>).actorUserId=state.target;
  if(reason==="forged-email")(state.binding!.support as Record<string,unknown>).actorEmail="forged@example.invalid";
  if(reason==="disabled")state.enabled=false;if(reason==="initial")state.initial=true;if(reason==="foreign")state.installed="trinalum-production";
  if(reason==="profile-drift")state.profile+="changed";if(reason==="acl-drift")state.permissions+="changed";
  if(reason==="owner-expired")state.ownerCheck.mockRejectedValue(Error("owner expired"));
  await expect(supportModelSponsor(identity())).rejects.toMatchObject({code:"MODEL_AUTH_UNAVAILABLE"});expect(state.provider).not.toHaveBeenCalled();
 });
 it.each(["symlink","uid","mode","hardlink"])("refuses unsafe root policy metadata: %s",async kind=>{
  state.unsafe=kind;await expect(supportModelSponsor(identity())).rejects.toMatchObject({code:"MODEL_AUTH_UNAVAILABLE"});
 });
 it("rechecks revocation after credentials snapshot before releasing it",async()=>{
  state.snapshot.mockImplementation(async()=>{state.binding=null;return {accessToken:"never-release"};});
  await expect(personalQaAuthProvider(identity())()).rejects.toMatchObject({code:"MODEL_AUTH_UNAVAILABLE"});
 });
 it("rechecks grants after snapshot and never releases credentials after ACL change",async()=>{
  state.snapshot.mockImplementation(async()=>{state.permissions+="changed";return {accessToken:"never-release"};});
  await expect(personalQaAuthProvider(identity())()).rejects.toMatchObject({code:"MODEL_AUTH_UNAVAILABLE"});
 });
 it("rechecks root policy expiry after snapshot",async()=>{
  state.snapshot.mockImplementation(async()=>{state.policy.expiresAt=Date.now()-1;return {accessToken:"never-release"};});
  await expect(personalQaAuthProvider(identity())()).rejects.toMatchObject({code:"MODEL_AUTH_UNAVAILABLE"});
 });
 it("rejects another target even when session hash is known",async()=>{
  await expect(supportModelSponsor({...identity(),userId:"10000000-0000-4000-8000-000000000003"})).rejects.toThrow();
 });
 it("keeps ordinary owner credentials on its original socket",async()=>{
  state.own=true;const owner={installationId:"g03-production",userId:state.owner};await personalQaAuthProvider(owner)();
  expect(state.provider).toHaveBeenCalledWith(owner);expect(state.session).not.toHaveBeenCalled();
 });
 it.each(["expired","future","too-long","foreign","duplicate","extra"])("rejects policy %s",kind=>{
  if(kind==="expired")state.policy.expiresAt=Date.now()-1;if(kind==="future")state.policy.createdAt=Date.now()+60000;
  if(kind==="too-long")state.policy.expiresAt=Number(state.policy.createdAt)+7200001;
  if(kind==="foreign")state.policy.installationId="other";if(kind==="duplicate")(state.policy.targets as unknown[]).push((state.policy.targets as unknown[])[0]);
  if(kind==="extra")state.policy.clientActor="forged";
  expect(()=>parseSupportModelQaPolicy(state.policy,identity())).toThrow();
 });
 it("blocks owner Apps and re-enablement on warm threads and config changes",()=>{
  expect(SPONSORED_MODEL_CONFIG_OVERRIDES).toContain("features.apps=false");
  for(const method of ["app/list","app/installed","app/read","app/call"])expect(()=>assertSponsoredModelRpc(method,{})).toThrow();
  for(const method of ["thread/start","thread/resume","turn/start","turn/steer"]){
   expect(()=>assertSponsoredModelRpc(method,{config:{"features.apps":true}})).toThrow();
   expect(()=>assertSponsoredModelRpc(method,{config:{apps:{personal:{enabled:true}}}})).toThrow();
   expect(()=>assertSponsoredModelRpc(method,{config:{"features.apps":false,apps:{_default:{enabled:false}}}})).not.toThrow();
  }
  expect(()=>assertSponsoredModelRpc("config/value/write",{keyPath:"apps.personal.enabled",value:true})).toThrow();
  expect(()=>assertSponsoredModelRpc("thread/resume",{config:{"apps.personal.enabled":true}})).toThrow();
 });
 it("covers both SDK config write forms, parent objects and all edits in a batch",()=>{
  const edit=(keyPath:string,value:unknown)=>({keyPath,value,mergeStrategy:"upsert"});
  for(const payload of [edit("features.apps",true),edit("features",{apps:true}),edit("apps",{owner:{enabled:true}}),
    edit("apps.owner",{enabled:true}),edit("",{features:{apps:true}}),edit('"features"."apps"',true)]) {
   expect(()=>assertSponsoredModelRpc("config/value/write",payload)).toThrow();
   expect(()=>assertSponsoredModelRpc("config/batchWrite",{edits:[edit("mcp_servers.allowed.enabled",true),payload],reloadUserConfig:true})).toThrow();
  }
  for(const payload of [edit("features.apps",false),edit("features",{apps:false}),edit("apps",{_default:{enabled:false}}),
    edit("apps.owner.enabled",false),edit("mcp_servers.allowed.enabled",true)]) {
   expect(()=>assertSponsoredModelRpc("config/value/write",payload)).not.toThrow();
   expect(()=>assertSponsoredModelRpc("config/batchWrite",{edits:[payload],reloadUserConfig:true})).not.toThrow();
  }
  expect(()=>assertSponsoredModelRpc("thread/resume",{config:{features:{apps:true}}})).toThrow();
  expect(()=>assertSponsoredModelRpc("config/batchWrite",{edits:{keyPath:"features.apps",value:true}})).toThrow();
 });

});

it("admits Supabase only through the current pinned support binding and sponsor", async () => {
 vi.stubEnv("AIBRAIN_AUTH_MODE", "supabase"); await personalQaAuthProvider(identity())();
 expect(state.provider).toHaveBeenCalledWith({ installationId: "g03-production", userId: state.owner });
 expect(state.ownerCheck).toHaveBeenCalledTimes(2);
});
it.each(["missing-binding", "expired-policy", "revoked-after-snapshot", "owner-unavailable", "acl-drift"])("Supabase support fails closed: %s", async kind => {
 vi.stubEnv("AIBRAIN_AUTH_MODE", "supabase");
 if (kind === "missing-binding") state.binding = null;
 if (kind === "expired-policy") state.policy.expiresAt = Date.now() - 1;
 if (kind === "owner-unavailable") state.ownerCheck.mockRejectedValue(Error("expired sponsor"));
 if (kind === "acl-drift") state.permissions += "changed";
 if (kind === "revoked-after-snapshot") state.snapshot.mockImplementation(async () => { state.binding = null; return { accessToken: "never-release" }; });
 await expect(personalQaAuthProvider(identity())()).rejects.toMatchObject({ code: "MODEL_AUTH_UNAVAILABLE" });
});
it.each([
 { AIBRAIN_AUTH_MODE: "demo" }, { AIBRAIN_AUTH_MODE: "unknown" }, { AIBRAIN_AUTH_MODE: "" },
 { AIBRAIN_MODEL_AUTH: "server-api-key" }, { AIBRAIN_MODEL_AUTH: "personal-codex" }, { AIBRAIN_MODEL_AUTH: "unknown" },
 { AIBRAIN_MODEL_AUTH: "" }, { AIBRAIN_CODEX_TRANSPORT: "gateway" }, { AIBRAIN_CODEX_AUTH_SCOPE: "shared" },
 { AIBRAIN_CODEX_AUTH_SCOPE: "" }, { AIBRAIN_CODEX_USER_ACCESS_SOCKET_ROOT: "" }, { OPENAI_API_KEY: "synthetic-forbidden" },
 { CODEX_API_KEY: "synthetic-forbidden" }, { AIBRAIN_SHARED_CODEX_AUTH_SOURCE: "/synthetic/shared" },
 { AIBRAIN_CODEX_OWNER_AUTH_SOCKET: "/synthetic/owner" }, { AIBRAIN_INSTALLATION_OWNER_AUTH_ACK: "yes" },
])("rejects unsupported Supabase QA configuration %#", async patch => {
 vi.stubEnv("AIBRAIN_AUTH_MODE", "supabase"); vi.stubEnv("NODE_ENV", "production");
 for (const [name, value] of Object.entries(patch)) vi.stubEnv(name, value);
 await expect(supportModelSponsor(identity())).rejects.toMatchObject({ code: "MODEL_AUTH_UNAVAILABLE" });
 expect(state.session).not.toHaveBeenCalled(); expect(state.provider).not.toHaveBeenCalled();
});

it("allows the Supabase owner's own finite profile without a sponsor binding", async () => {
 vi.stubEnv("AIBRAIN_AUTH_MODE", "supabase"); state.own = true;
 const owner = { installationId: "g03-production", userId: state.owner }; await personalQaAuthProvider(owner)();
 expect(state.provider).toHaveBeenCalledWith(owner); expect(state.session).not.toHaveBeenCalled(); expect(state.ownerCheck).not.toHaveBeenCalled();
});
it.each(["demo", "unknown"])("does not let an own profile bypass the QA auth mode: %s", async mode => {
 state.own = true; vi.stubEnv("AIBRAIN_AUTH_MODE", mode);
 await expect(personalQaAuthProvider(identity())()).rejects.toMatchObject({ code: "MODEL_AUTH_UNAVAILABLE" });
 expect(state.provider).not.toHaveBeenCalled();
});
it("rejects a model-mode change after the snapshot before releasing credentials", async () => {
 vi.stubEnv("AIBRAIN_AUTH_MODE", "supabase"); state.own = true;
 state.snapshot.mockImplementation(async () => { vi.stubEnv("AIBRAIN_MODEL_AUTH", "server-api-key"); return { accessToken: "never-release" }; });
 await expect(personalQaAuthProvider(identity())()).rejects.toMatchObject({ code: "MODEL_AUTH_UNAVAILABLE" });
});
