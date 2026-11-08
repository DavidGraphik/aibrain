import "server-only";
import { createHmac } from "node:crypto";
import { mailEncryptionKey } from "./mail-store";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { isMailRecord, MailConnectorError, type MailTransport } from "./mail-contracts";
import { safeMailSearchDiagnostic } from "./mail-search-diagnostic";
import { operationalLogger } from "@/operations/server-logger";

/** Credentials travel only on stdin, never arguments, environment or logs. */
export const nominaliaMailTransport: MailTransport = async (operation, credentials, args) => {
  const packaged = "/usr/local/share/aibrain/nominalia-mail.py";
  const script = existsSync(packaged) ? packaged : path.join(process.cwd(), "scripts", "nominalia-mail.py");
  return new Promise((resolve, reject) => {
    // Start the search budget before spawning Python, reserving 15 seconds of
    // the transport's 60-second limit for startup, cleanup and serialization.
    const searchDeadlineAt = Date.now() + 45_000;
    const child = spawn("python3", [script], { stdio: ["pipe", "pipe", "pipe"], env: { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH, AIBRAIN_EGRESS_PROXY_URL: process.env.AIBRAIN_EGRESS_PROXY_URL, AIBRAIN_EGRESS_SERVER_TOKEN: process.env.AIBRAIN_EGRESS_SERVER_TOKEN } });
    const output: Buffer[] = []; let size = 0, done = false, diagnostic = "", diagnosticOverflow = false;
    const finish = (error?: MailConnectorError, result?: unknown) => { if (done) return; done = true; clearTimeout(timer); if (error) reject(error); else resolve(result); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new MailConnectorError("MAIL_TIMEOUT", 504)); }, 60_000);
    child.stdout.on("data", (chunk: Buffer) => { if (done) return; size += chunk.length; if (size > 12 * 1024 * 1024) { child.kill("SIGKILL"); finish(new MailConnectorError("MAIL_RESPONSE_TOO_LARGE", 502)); } else output.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => {
      if (diagnosticOverflow) return;
      if (Buffer.byteLength(diagnostic) + chunk.length > 512) { diagnostic = ""; diagnosticOverflow = true; return; }
      diagnostic += chunk.toString("utf8");
    });
    child.on("error", () => finish(new MailConnectorError("MAIL_TRANSPORT_UNAVAILABLE", 503)));
    child.stdin.on("error", () => finish(new MailConnectorError("MAIL_TRANSPORT_UNAVAILABLE", 503)));
    child.on("close", (exitCode) => {
      if (done) return;
      try {
        const response: unknown = JSON.parse(Buffer.concat(output).toString("utf8"));
        if (exitCode !== 0 || !isMailRecord(response) || response.ok !== true) {
          const safeDiagnostic = !diagnosticOverflow && (operation === "search" || operation === "list") ? safeMailSearchDiagnostic(diagnostic) : null;
          if (safeDiagnostic) operationalLogger.warn("mail.search_diagnostic", { diagnostic: safeDiagnostic });
          const providerCode = isMailRecord(response) && isMailRecord(response.error) && typeof response.error.code === "string" && /^[A-Z_]{1,60}$/.test(response.error.code) ? response.error.code : "PROVIDER_FAILED";
          const code = providerCode.startsWith("MAIL_") ? providerCode : `MAIL_${providerCode}`;
          finish(new MailConnectorError(code, 502));
        } else finish(undefined, response.result);
      } catch { finish(new MailConnectorError("MAIL_TRANSPORT_INVALID", 502)); }
    });
    // Independent server key: never expose an offline verifier derived from the
    // employee's mailbox password in a cursor returned to the model/browser.
    const cursorSecret = createHmac("sha256", mailEncryptionKey()).update(`nominalia-search-cursor-v1\0${credentials.email.toLowerCase()}`).digest("hex");
    child.stdin.end(JSON.stringify({ operation, credentials: { ...credentials, cursorSecret }, args, searchDeadlineAt }));
  });
};
