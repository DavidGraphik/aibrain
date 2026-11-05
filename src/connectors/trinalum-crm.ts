import { deploymentIdentity } from "@/deployment/identities";
import "server-only";
import { readFile } from "node:fs/promises";
import { unixBrokerFetch } from "@/runtime/trinalum-broker-transport";

export type TrinalumDeal = { id: string; name: string; stage: string; owner: string; next_step: string; action_deadline: string; next_task: { id: string; content: string; deadline_at: string } | null; open_task_count: number };
export type TrinalumMember = { id: { workspace_member_id: string }; first_name?: string; last_name?: string; email_address: string };

/** Fixed CRM projection: caller identity is supplied exclusively by the server session. */
export async function trinalumCrm(installationId: string, userId: string, options: { configPath?: string; fetcher?: typeof unixBrokerFetch } = {}) {
  if (installationId !== "trinalum-production" || !/^[a-f0-9-]{36}$/.test(userId)) throw Error("TRINALUM_ACCESS_DENIED");
  const file = options.configPath ?? process.env.AIBRAIN_TRINALUM_BRIDGE_CONFIG;
  if (!file?.startsWith("/")) throw Error("TRINALUM_CRM_NOT_CONFIGURED");
  const config = JSON.parse(await readFile(file, "utf8"));
  const binding = config.users?.[userId];
  if (config.installationId !== installationId || binding?.status !== "active" || typeof binding.token !== "string" || binding.token.length < 32 || config.socketPath !== "/run/trinalum-broker/broker.sock") throw Error("TRINALUM_ACCESS_DENIED");
  const fetcher = options.fetcher ?? unixBrokerFetch;
  const read = async (operation: string) => {
    const res = await fetcher(config.socketPath, new URL("http://127.0.0.1/read"), { method: "POST", headers: { Authorization: `Bearer ${binding.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ operation, input: {} }), signal: AbortSignal.timeout(50_000) });
    if (!res.ok) throw Error(res.status === 403 ? "TRINALUM_ACCESS_DENIED" : "TRINALUM_CRM_UNAVAILABLE");
    return (await res.json()).data;
  };
  const [records, members] = await Promise.all([read("attio_deals"), read("attio_members")]);
  if (!Array.isArray(records?.deals) || !Array.isArray(members?.data)) throw Error("TRINALUM_CRM_UNAVAILABLE");
  return { deals: records.deals as TrinalumDeal[], members: members.data as TrinalumMember[], checkedAt: new Date().toISOString() };
}

export function crmView(deals: TrinalumDeal[], members: TrinalumMember[], view: string) {
  if (view === "trini") return deals;
  const email = view === "miguel" ? deploymentIdentity("sales") : view === "nerea" ? deploymentIdentity("administration") : null;
  const owner = members.find(m => m.email_address?.toLowerCase() === email)?.id.workspace_member_id;
  if (!owner) throw Error("TRINALUM_OWNER_NOT_FOUND");
  return deals.filter(d => d.owner === owner);
}
