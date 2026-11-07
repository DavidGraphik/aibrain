import { AuthenticationFailure, ImapFlow, type ImapFlowOptions, type MessageStructureObject } from "imapflow";
import type { InstallationConfig } from "@/config/installation-schema";
import { CompanyMailError, type CompanyMailCredential } from "./company-mail-contracts";

export const MAX_MAIL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export function companyMailClientOptions(config: Readonly<InstallationConfig>, credential: CompanyMailCredential, env: Readonly<Record<string, string | undefined>> = process.env): ImapFlowOptions {
  const host = config.connectors?.companyMail?.host;
  if (!config.connectors?.companyMail?.enabled || !host) throw new CompanyMailError("MAIL_NOT_ENABLED", "El correo de empresa no está habilitado.", 404);
  const hosts = new Set((env.AIBRAIN_EGRESS_MAIL_HOSTS ?? "").split(",").filter(Boolean));
  if (!hosts.has(host)) throw new CompanyMailError("MAIL_EGRESS_NOT_CONFIGURED", "El administrador debe habilitar la conexión segura al servidor de correo.", 503);
  let proxy: URL;
  try { proxy = new URL(env.AIBRAIN_EGRESS_PROXY_URL ?? ""); }
  catch { throw new CompanyMailError("MAIL_PROXY_NOT_CONFIGURED", "Falta configurar la conexión de correo en el servidor.", 503); }
  if (proxy.origin !== "http://egress-gateway:8080" || proxy.username || proxy.password || proxy.pathname !== "/" || proxy.search || proxy.hash || !/^[A-Za-z0-9_-]{32,512}$/u.test(env.AIBRAIN_EGRESS_SERVER_TOKEN ?? "")) {
    throw new CompanyMailError("MAIL_PROXY_NOT_CONFIGURED", "Falta configurar la conexión de correo en el servidor.", 503);
  }
  proxy.username = "aibrain";
  proxy.password = env.AIBRAIN_EGRESS_SERVER_TOKEN!;
  return { host, port: 993, secure: true, servername: host, tls: { rejectUnauthorized: true, minVersion: "TLSv1.2", servername: host },
    auth: { user: credential.email, pass: credential.password }, proxy: proxy.toString(),
    logger: false, logRaw: false, emitLogs: false, disableAutoIdle: true, disableCompression: true,
    connectionTimeout: 15_000, greetingTimeout: 10_000, socketTimeout: 30_000 };
}

export async function withCompanyMailbox<T>(config: Readonly<InstallationConfig>, credential: CompanyMailCredential, action: (client: ImapFlow) => Promise<T>, signal?: AbortSignal) {
  const client = new ImapFlow(companyMailClientOptions(config, credential));
  // Socket errors never include passwords or provider responses in logs or UI.
  client.on("error", () => client.close());
  const abort = () => client.close();
  const timeout = setTimeout(abort, 180_000);
  timeout.unref();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) throw new CompanyMailError("MAIL_CANCELLED", "Trabajo de correo cancelado.");
    await client.connect();
    const lock = await client.getMailboxLock(credential.folder, { readOnly: true });
    try {
      if (!client.mailbox || !client.mailbox.readOnly) throw new CompanyMailError("MAIL_READONLY_REQUIRED", "El buzón requiere lectura sin modificaciones.");
      return await action(client);
    } finally { lock.release(); }
  } catch (error) {
    if (error instanceof CompanyMailError) throw error;
    if (signal?.aborted) throw new CompanyMailError("MAIL_CANCELLED", "Trabajo de correo cancelado.");
    if (error instanceof AuthenticationFailure || error && typeof error === "object" && "authenticationFailed" in error && error.authenticationFailed === true) throw new CompanyMailError("MAIL_LOGIN_REQUIRED", "Reconecta el buzón desde Ajustes.", 401);
    throw new CompanyMailError("MAIL_CONNECTION_FAILED", "No se ha podido leer el buzón. Revisa la contraseña, la carpeta o la conexión desde Ajustes.", 502);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    client.close();
  }
}

export type MailAttachmentPart = { part: string; name: string; type: string; size: number };
/** Embedded emails and inline images are not invoice attachments. */
export function companyMailAttachmentParts(node: MessageStructureObject | undefined, depth = 0): MailAttachmentPart[] {
  if (!node || depth > 20 || node.type.toLowerCase() === "message/rfc822") return [];
  if (node.childNodes) return node.childNodes.flatMap(child => companyMailAttachmentParts(child, depth + 1));
  const name = node.dispositionParameters?.filename ?? node.parameters?.name;
  if (!name || !node.part || !/^\d+(?:\.\d+)*$/u.test(node.part) || node.disposition?.toLowerCase() === "inline") return [];
  return [{ part: node.part, name, type: node.type, size: node.size ?? 0 }];
}

export async function downloadCompanyMailAttachment(client: ImapFlow, uid: number, part: MailAttachmentPart, onBytes?: (bytes: number) => void) {
  if (part.size > MAX_MAIL_ATTACHMENT_BYTES * 1.4) throw new CompanyMailError("MAIL_ATTACHMENT_TOO_LARGE", "Adjunto demasiado grande; revisión manual pendiente.");
  const download = await client.download(String(uid), part.part, { uid: true, maxBytes: MAX_MAIL_ATTACHMENT_BYTES + 1 });
  if (!download.content) throw new CompanyMailError("MAIL_ATTACHMENT_MISSING", "El adjunto no está disponible; vuelve a importar.");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of download.content) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    try { onBytes?.(bytes.length); } catch (error) { download.content.destroy(); throw error; }
    if (total > MAX_MAIL_ATTACHMENT_BYTES) {
      download.content.destroy();
      throw new CompanyMailError("MAIL_ATTACHMENT_TOO_LARGE", "Adjunto demasiado grande; revisión manual pendiente.");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
