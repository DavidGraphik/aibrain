import "server-only";
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
export async function g03SageAccess(installationId: string, userId: string) {
  if (installationId !== "g03-production" || !/^[a-f0-9-]{36}$/.test(userId)) return denied();
  const installation = await loadInstallationConfig();
  if (installation.installationId !== installationId) return denied();
  const actor = await new FileLocalUserStore(installation.paths.usersRoot).read(userId);
  if (!actor?.enabled || actor.userId !== userId) return denied();
  const catalog = await catalogRuntimeEnforcer(installationId, userId);
  if (!catalog.allowsConnector("g03-sage")) return denied();
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
  return { reader, key, receiving, operations:data.operations, catalogWrite:typeof catalog.allowsConnectorWrite==="function"&&catalog.allowsConnectorWrite("g03-sage") };
}
export async function g03SageReadForIdentity(installationId: string, userId: string, operation: "discover" | "read", args: Record<string, unknown>, signal?: AbortSignal) {
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
export async function g03SageHealth(installationId: string, userId: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let accessVerified = false;
  try {
    const { reader } = await g03SageAccess(installationId,userId);
    accessVerified = true;
    await Promise.race([reader.discover(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new SageError("SAGE_HEALTH_PENDING")),2000);})]);
    return { status: "connected", statusCode: "SAGE_READ_ONLY_VERIFIED", accessVerified };
  } catch(error) {
    return error instanceof SageError && error.code !== "SAGE_NOT_CONFIGURED" && error.code !== "SAGE_ACCESS_DENIED"
      ? { status: "unavailable", statusCode: error.code, accessVerified } : { status: "not_configured", statusCode: "G03_SAGE_API_PENDING", accessVerified: false };
  } finally { clearTimeout(timer); }
}

/** Private installation policy; absent settings never enable provider or Production writes. */
export async function g03SageReceivingCapabilities(installationId:string,userId:string) {
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
