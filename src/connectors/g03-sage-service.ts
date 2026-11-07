import "server-only";
import { privateReadBridge, privateSageCapability, PrivateReadBridgeError } from "./private-read-bridge";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { loadInstallationConfig } from "@/config/installation";
import { FileLocalUserStore } from "@/auth/local-user-store";
import { catalogRuntimeEnforcer } from "@/catalog/access-service";
import { collectSagePages } from "./g03-sage-batch";
import { SageReader, SageError, SAGE_QUERIES, sageRecord, type SageCredential, type SageQuery } from "./g03-sage-api";
const readers = new Map<string, SageReader>();
const denied = (): never => { throw new SageError("SAGE_ACCESS_DENIED"); };
async function g03SagePrincipal(installationId: string, userId: string) {
  if (installationId !== "g03-production" || !/^[a-f0-9-]{36}$/.test(userId)) return denied();
  const installation = await loadInstallationConfig();
  if (installation.installationId !== installationId) return denied();
  const actor = await new FileLocalUserStore(installation.paths.usersRoot).read(userId);
  if (!actor?.enabled || actor.userId !== userId) return denied();
  const catalog = await catalogRuntimeEnforcer(installationId, userId);
  if (!catalog.allowsConnector("g03-sage")) return denied();
  return { installation, catalog };
}
export async function g03SageAccess(installationId: string, userId: string) {
  if (await privateReadBridge(installationId, userId)) throw Object.assign(new SageError("SAGE_READ_ONLY"), { status: 403 });
  const { catalog } = await g03SagePrincipal(installationId, userId);
  const filename = process.env.AIBRAIN_G03_SAGE_CONFIG?.trim() || path.join((await loadInstallationConfig()).paths.dataRoot,"g03-sage","config.json");
  if (!path.isAbsolute(filename)) throw new SageError("SAGE_NOT_CONFIGURED");
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > 32_768) return denied();
    bytes = await handle.readFile(); if (bytes.length > 32_768) return denied();
  } finally { await handle.close(); }
  let data: unknown; try { data = JSON.parse(bytes.toString("utf8")); } catch { throw new SageError("SAGE_CONFIG_INVALID"); }
  if (!sageRecord(data) || data.installationId !== installationId || data.companyCode !== "1" || !Array.isArray(data.allowedUserIds) || !data.allowedUserIds.includes(userId)
    || !Array.isArray(data.allowedQueries) || !data.allowedQueries.length || data.allowedQueries.some(name => typeof name !== "string" || !Object.hasOwn(SAGE_QUERIES,name))
    || typeof data.baseUrl !== "string" || typeof data.username !== "string" || typeof data.password !== "string" || typeof data.appId !== "string") return denied();
  const key = createHash("sha256").update(bytes).digest("hex");
  let reader = readers.get(key);
  if (!reader) {
    reader = new SageReader({ baseUrl: data.baseUrl, username: data.username, password: data.password, appId: data.appId, allowedQueries: data.allowedQueries as SageQuery[] } satisfies SageCredential);
    if (readers.size >= 4) readers.delete(readers.keys().next().value!);
    readers.set(key, reader);
  }
  const receiving = sageRecord(data.receiving) && Array.isArray(data.receiving.allowedWriteUserIds) && data.receiving.allowedWriteUserIds.includes(userId)
    ? {providerWrites:data.receiving.providerWrites===true,productionWrites:data.receiving.productionWrites===true}
    : {providerWrites:false,productionWrites:false};
  return { reader, key, receiving, allowedQueries: data.allowedQueries as SageQuery[], operations:data.operations, catalogWrite:typeof catalog.allowsConnectorWrite==="function"&&catalog.allowsConnectorWrite("g03-sage") };
}
export async function g03SageReadForIdentity(installationId: string, userId: string, operation: "discover" | "read", args: Record<string, unknown>, signal?: AbortSignal) {
  const bridge = await privateReadBridge(installationId, userId);
  if (bridge) {
    await g03SagePrincipal(installationId, userId);
    try { const value = await bridge.request("sage", { operation: operation, input: args }, signal); await g03SagePrincipal(installationId, userId); return value; }
    catch (error) { if (error instanceof PrivateReadBridgeError) throw Object.assign(new SageError(error.code), { status: error.status }); throw error; }
  }
  signal?.throwIfAborted();
  const initial = await g03SageAccess(installationId,userId);
  const value = operation === "discover" ? await initial.reader.discover(signal) : await initial.reader.read(args.query, args.parameters ?? {}, args.skip ?? 0, args.take ?? 10, signal);
  // A revocation/credential replacement during a provider read must not release the result.
  signal?.throwIfAborted();
  const fresh = await g03SageAccess(installationId,userId);
  if (fresh.key !== initial.key) throw new SageError("SAGE_CONNECTION_CHANGED");
  signal?.throwIfAborted();
  return value;
}
/** Group consecutive pages inside the connector, retaining the native query contract. */
export async function g03SageReadBatchForIdentity(installationId: string, userId: string, args: Record<string, unknown>, signal?: AbortSignal) {
  const bridge = await privateReadBridge(installationId, userId);
  if (bridge) {
    await g03SagePrincipal(installationId, userId);
    try { const value = await bridge.request("sage", { operation: "read_batch", input: args }, signal); await g03SagePrincipal(installationId, userId); return value; }
    catch (error) { if (error instanceof PrivateReadBridgeError) throw Object.assign(new SageError(error.code), { status: error.status }); throw error; }
  }
  signal?.throwIfAborted();
  const initial = await g03SageAccess(installationId, userId);
  let parameters = args.parameters ?? {};
  if ((args.query === "SalesOrders" || args.query === "PurchaseOrders") && sageRecord(parameters) && Object.keys(parameters).length === 0) {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    parameters = { FechaInicial: "1900-01-01", FechaFinal: today };
  }
  const reader = initial.reader.forkForRead();
  const value = await collectSagePages(async (query, pageParameters, skip, take, pageSignal) => {
    pageSignal.throwIfAborted();
    const current = await g03SageAccess(installationId, userId);
    if (current.key !== initial.key) throw new SageError("SAGE_CONNECTION_CHANGED");
    pageSignal.throwIfAborted();
    return reader.read(query, pageParameters, skip, take, pageSignal);
  }, args.query, parameters, args.skip ?? 0, args.take ?? 50, signal);
  signal?.throwIfAborted();
  const fresh = await g03SageAccess(installationId, userId);
  if (fresh.key !== initial.key) throw new SageError("SAGE_CONNECTION_CHANGED");
  signal?.throwIfAborted();
  return value;
}
/** Admission metadata follows the same source-held read grant as execution, without constructing a remote reader. */
export async function g03SageReadCapabilities(installationId: string, userId: string) {
  const bridge = await privateReadBridge(installationId, userId);
  if (bridge) {
    await g03SagePrincipal(installationId, userId);
    try {
      const source = privateSageCapability(await bridge.request("capabilities", {}));
      await g03SagePrincipal(installationId, userId);
      return { transport: "source-native" as const, readOperations: source.operations, queries: source.queries, providerReachability: "not-tested" as const, writesAllowed: false };
    } catch (error) { if (error instanceof PrivateReadBridgeError) throw Object.assign(new SageError(error.code), { status: error.status }); throw error; }
  }
  const source = await g03SageAccess(installationId, userId);
  return { transport: "local" as const, readOperations: ["discover", "read", "read_batch"] as const, queries: source.allowedQueries.map(name => ({ name, ...SAGE_QUERIES[name] })), providerReachability: "not-tested" as const, writesAllowed: undefined };
}
export async function g03SageHealth(installationId: string, userId: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let accessVerified = false;
  try {
    const bridge = await privateReadBridge(installationId, userId);
    if (bridge) {
      const capabilities = await g03SageReadCapabilities(installationId, userId);
      return { status: "connected", statusCode: "SOURCE_PERMISSION_VERIFIED_REACHABILITY_UNTESTED", accessVerified: true, readOperations: capabilities.readOperations, queries: capabilities.queries, transport: capabilities.transport };
    }
    const { reader } = await g03SageAccess(installationId,userId);
    accessVerified = true;
    await Promise.race([reader.discover(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new SageError("SAGE_HEALTH_PENDING")),2000);})]);
    return { status: "connected", statusCode: "SAGE_READ_ONLY_VERIFIED", accessVerified };
  } catch(error) {
    if (error instanceof PrivateReadBridgeError || error instanceof SageError && process.env.AIBRAIN_PRIVATE_READ_BRIDGE_CONFIG) return { status: error.code === "SAGE_ACCESS_DENIED" || error.code === "PRIVATE_READ_BINDING_DENIED" ? "not_configured" : "unavailable", statusCode: error.code, accessVerified: false };
    return error instanceof SageError && error.code !== "SAGE_NOT_CONFIGURED" && error.code !== "SAGE_ACCESS_DENIED"
      ? { status: "unavailable", statusCode: error.code, accessVerified } : { status: "not_configured", statusCode: "G03_SAGE_API_PENDING", accessVerified: false };
  } finally { clearTimeout(timer); }
}

/** Private installation policy; absent settings never enable provider or Production writes. */
export async function g03SageReceivingCapabilities(installationId:string,userId:string) {
  if (await privateReadBridge(installationId, userId)) return { providerWrites: false, productionWrites: false };
  return (await g03SageAccess(installationId,userId)).receiving;
}
export async function g03SageReceiptWriteForIdentity(installationId:string,userId:string,payload:unknown) {
  const initial=await g03SageAccess(installationId,userId);
  if(!initial.receiving.providerWrites||!initial.receiving.productionWrites)throw new SageError("SAGE_RECEIVING_WRITES_DISABLED");
  const result=await initial.reader.insertPurchaseReceipt(payload);
  const fresh=await g03SageAccess(installationId,userId);
  if(fresh.key!==initial.key||!fresh.receiving.providerWrites||!fresh.receiving.productionWrites)throw new SageError("SAGE_CONNECTION_CHANGED");
  return result;
}
