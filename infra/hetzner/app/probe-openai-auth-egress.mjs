import net from "node:net";
import tls from "node:tls";

const proxyValue = process.env.AIBRAIN_EGRESS_PROXY_URL?.trim();
const token = process.env.AIBRAIN_EGRESS_WORKER_TOKEN?.trim();
if (!proxyValue || !token || !/^[A-Za-z0-9_-]{32,256}$/u.test(token)) {
  throw new Error("OPENAI_AUTH_EGRESS_CONFIG_INVALID");
}
const proxy = new URL(proxyValue);
if (proxy.protocol !== "http:" || proxy.username || proxy.password || proxy.pathname !== "/") {
  throw new Error("OPENAI_AUTH_EGRESS_PROXY_INVALID");
}
const timeoutMs = 10_000;
const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port || 80) });
socket.setTimeout(timeoutMs, () => socket.destroy(new Error("OPENAI_AUTH_EGRESS_PROXY_TIMEOUT")));
await new Promise((resolve, reject) => {
  socket.once("connect", resolve);
  socket.once("error", reject);
});
socket.write([
  "CONNECT auth.openai.com:443 HTTP/1.1",
  "Host: auth.openai.com:443",
  `Proxy-Authorization: Bearer ${token}`,
  "Connection: close",
  "",
  "",
].join("\r\n"));

let buffered = Buffer.alloc(0);
while (!buffered.includes("\r\n\r\n")) {
  const chunk = await new Promise((resolve, reject) => {
    socket.once("data", resolve);
    socket.once("error", reject);
    socket.once("end", () => reject(new Error("OPENAI_AUTH_EGRESS_PROXY_EOF")));
  });
  buffered = Buffer.concat([buffered, chunk]);
  if (buffered.length > 16_384) throw new Error("OPENAI_AUTH_EGRESS_PROXY_RESPONSE_TOO_LARGE");
}
const proxyStatus = Number(/^HTTP\/1\.[01] ([0-9]{3})/u.exec(buffered.toString("latin1"))?.[1]);
if (proxyStatus !== 200) throw new Error(`OPENAI_AUTH_EGRESS_CONNECT_STATUS_${proxyStatus || "INVALID"}`);

const secure = tls.connect({ socket, servername: "auth.openai.com", rejectUnauthorized: true });
secure.setTimeout(timeoutMs, () => secure.destroy(new Error("OPENAI_AUTH_EGRESS_TLS_TIMEOUT")));
await new Promise((resolve, reject) => {
  secure.once("secureConnect", resolve);
  secure.once("error", reject);
});
if (!secure.authorized) throw new Error("OPENAI_AUTH_EGRESS_TLS_UNAUTHORIZED");
secure.write("GET /oauth/token HTTP/1.1\r\nHost: auth.openai.com\r\nConnection: close\r\n\r\n");
let response = Buffer.alloc(0);
while (!response.includes("\r\n\r\n")) {
  const chunk = await new Promise((resolve, reject) => {
    secure.once("data", resolve);
    secure.once("error", reject);
    secure.once("end", () => reject(new Error("OPENAI_AUTH_EGRESS_TLS_EOF")));
  });
  response = Buffer.concat([response, chunk]);
  if (response.length > 16_384) throw new Error("OPENAI_AUTH_EGRESS_ENDPOINT_RESPONSE_TOO_LARGE");
}
const endpointStatus = Number(/^HTTP\/1\.[01] ([0-9]{3})/u.exec(response.toString("latin1"))?.[1]);
secure.destroy();
if (endpointStatus !== 405) throw new Error(`OPENAI_AUTH_EGRESS_ENDPOINT_STATUS_${endpointStatus || "INVALID"}`);
process.stdout.write("OPENAI_AUTH_EGRESS_OK connect=200 tls=authorized endpoint=405\n");
