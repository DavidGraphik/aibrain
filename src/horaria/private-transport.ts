import "server-only";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** Only for the operator-configured, signed installation service. This creates a
 * direct one-off agent, leaving AiBrain's external egress proxy unchanged. */
export async function privateHorariaRequest(baseUrl: string, target: string, options: { method: string; headers: HeadersInit; body?: Uint8Array; signal: AbortSignal }): Promise<Response> {
  const url = new URL(target, baseUrl);
  if (url.origin !== new URL(baseUrl).origin || !["http:", "https:"].includes(url.protocol) || !url.pathname.startsWith("/api/")) throw new Error("Invalid private service target");
  const headers = Object.fromEntries(new Headers(options.headers));
  return new Promise((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(url, { method: options.method, headers, agent: false, signal: options.signal }, response => {
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) { response.destroy(new Error("Private response too large")); return; }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        const status = response.statusCode ?? 502;
        if (status >= 300 && status < 400) { reject(new Error("Private service redirects are forbidden")); return; }
        const resultHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) resultHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
        resolve(new Response(options.method === "HEAD" || [204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: resultHeaders }));
      });
    });
    request.on("error", reject);
    request.end(options.body);
  });
}
