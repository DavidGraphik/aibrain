import { Agent, request, type AgentOptions } from "node:https";

const routes = new Set(["/api/auth/Login", "/api/DataQuery/GetQuery", "/api/DataQuery/GetQueryList", "/api/DataQuery/GetTableFields", "/api/PutData/allowedTables", "/api/PutData/InsertData"]);
const failure = () => new Error("SAGE_EGRESS_UNAVAILABLE");
/** Backend-only HTTP transport. The server channel token never enters worker environments. */
export function createSageServerFetch(
  environment: Readonly<Record<string,string|undefined>> = process.env,
  agentFactory: (options: AgentOptions) => Agent = options => new Agent(options),
): typeof fetch {
  return async (input, init) => {
    let destination: URL, proxy: URL;
    try {
      if (typeof input !== "string" && !(input instanceof URL)) throw failure();
      destination = new URL(input);
      proxy = new URL(environment.AIBRAIN_EGRESS_PROXY_URL ?? "");
    } catch { throw failure(); }
    const serverToken = environment.AIBRAIN_EGRESS_SERVER_TOKEN ?? "";
    if (proxy.origin !== "http://egress-gateway:8080" || proxy.username || proxy.password || proxy.pathname !== "/" || proxy.search || proxy.hash || !/^[A-Za-z0-9_-]{32,512}$/u.test(serverToken)
      || destination.protocol !== "https:" || destination.username || destination.password || destination.port || destination.search || destination.hash || !routes.has(destination.pathname)
      || init?.method !== "POST" || init.redirect !== "error" || typeof init.body !== "string" || Buffer.byteLength(init.body) > 64 * 1024 || init.signal?.aborted) throw failure();
    const headers = new Headers(init.headers);
    if (headers.get("content-type") !== "application/json" || [...headers.keys()].some(key => !["content-type","authorization"].includes(key))) throw failure();
    proxy.username = "aibrain"; proxy.password = serverToken;
    // Explicit per-agent settings: never enable global proxy behavior or a direct-network fallback.
    // Node >=24.5 tunnels HTTPS through CONNECT and leaves target DNS to the gateway.
    const proxyUrl = proxy.href;
    const agent = agentFactory({ keepAlive: false, maxCachedSessions: 0, rejectUnauthorized: true, minVersion: "TLSv1.2",
      proxyEnv: { NODE_ENV: "production", HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl, NO_PROXY: "", no_proxy: "" } });
    return new Promise<Response>((resolve,reject) => {
      let finished = false;
      const finish = (error?: Error, value?: Response) => {
        if (finished) return; finished = true;
        clearTimeout(timer); init.signal?.removeEventListener("abort",abort); agent.destroy();
        if (error) reject(failure()); else resolve(value!);
      };
      const req = request(destination,{ method:"POST",agent,headers:Object.fromEntries(headers),maxHeaderSize:16*1024 },res => {
        const chunks:Buffer[]=[];let size=0;
        if (Number(res.headers["content-length"]) > 1024*1024) { req.destroy(); finish(failure()); return; }
        res.on("data",(chunk:Buffer)=>{size+=chunk.length;if(size>1024*1024){req.destroy();finish(failure());}else chunks.push(chunk);});
        res.on("error",()=>finish(failure()));
        res.on("end",()=>{
          if (finished) return;
          try { const status=res.statusCode??502;finish(undefined,new Response([204,205,304].includes(status)?null:Buffer.concat(chunks),{status,headers:{"content-type":String(res.headers["content-type"]??"application/json")}})); }
          catch { finish(failure()); }
        });
      });
      const abort = () => { req.destroy(); finish(failure()); };
      // Real IME processing can finish after the read deadline. Keep one bounded
      // attempt; a timeout still means unknown, never an automatic write retry.
      const timer = setTimeout(abort,destination.pathname === "/api/PutData/InsertData" ? 60_000 : 15_000);
      init.signal?.addEventListener("abort",abort,{once:true});
      req.on("error",()=>finish(failure()));
      if (init.signal?.aborted) abort(); else req.end(init.body);
    });
  };
}
export const sageServerFetch = createSageServerFetch();
