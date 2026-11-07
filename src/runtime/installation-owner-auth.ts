import { request } from "node:http";

type OwnerAccess = { accessToken: string; chatgptAccountId: string; chatgptPlanType?: string };

/** Backend-only socket. It is never passed into the employee process environment. */
export function installationOwnerAuthSocket(installationId: string, environment: Record<string, string | undefined> = process.env): string | null {
  const socket = environment.AIBRAIN_CODEX_OWNER_AUTH_SOCKET?.trim();
  if (!socket) return null;
  if (installationId !== "trinalum-production"
      || environment.AIBRAIN_CODEX_AUTH_SCOPE !== "installation-owner"
      || environment.AIBRAIN_INSTALLATION_OWNER_AUTH_ACK !== installationId
      || socket !== "/run/trinalum-owner-auth/broker.sock") {
    throw new Error("Installation owner authentication is not authorized.");
  }
  return socket;
}

export function readInstallationOwnerAccess(installationId: string, previousAccountId?: string): Promise<OwnerAccess> {
  const socketPath = installationOwnerAuthSocket(installationId);
  if (!socketPath) throw new Error("Installation owner authentication is unavailable.");
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ installationId, previousAccountId });
    const req = request({ socketPath, path: "/access", method: "POST", headers: {
      "content-type": "application/json", "content-length": Buffer.byteLength(body),
    } }, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
        if (data.length > 32_768) req.destroy(new Error("Owner authentication response exceeds its limit."));
      });
      res.on("error", () => reject(new Error("Owner authentication is unavailable.")));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error("Owner authentication is unavailable."));
          return;
        }
        try {
          const value: unknown = JSON.parse(data);
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
          const item = value as Record<string, unknown>;
          if (Object.keys(item).some((key) => !["accessToken", "chatgptAccountId", "chatgptPlanType"].includes(key))
              || typeof item.accessToken !== "string" || item.accessToken.length < 32
              || typeof item.chatgptAccountId !== "string" || !item.chatgptAccountId
              || previousAccountId && item.chatgptAccountId !== previousAccountId
              || item.chatgptPlanType !== undefined && typeof item.chatgptPlanType !== "string") throw new Error();
          resolve(item as OwnerAccess);
        } catch { reject(new Error("Owner authentication returned an invalid account.")); }
      });
    });
    const deadline = setTimeout(() => req.destroy(new Error("Owner authentication timed out.")), 8_500);
    req.once("close", () => clearTimeout(deadline));
    req.on("error", () => reject(new Error("Owner authentication is unavailable.")));
    req.end(body);
  });
}
