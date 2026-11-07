#!/usr/bin/env node

const TOKEN = /^[A-Za-z0-9_-]{32,256}$/u;
const EXACT_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const proxy = new URL(required("AIBRAIN_EGRESS_PROXY_URL"));
if (proxy.protocol !== "http:" || proxy.hostname !== "egress-gateway" || proxy.port !== "8080" ||
    proxy.username || proxy.password || proxy.pathname !== "/" || proxy.search || proxy.hash) {
  throw new Error("AIBRAIN_EGRESS_PROXY_URL must be the private gateway origin");
}

const tokens = [
  required("AIBRAIN_EGRESS_BROWSER_TOKEN"),
  required("AIBRAIN_EGRESS_WORKER_TOKEN"),
  required("AIBRAIN_EGRESS_SERVER_TOKEN"),
];
if (tokens.some((token) => !TOKEN.test(token)) || new Set(tokens).size !== tokens.length) {
  throw new Error("egress channel tokens must be strong and pairwise distinct");
}

const mailHosts = (process.env.AIBRAIN_EGRESS_MAIL_HOSTS ?? "").split(",").filter(Boolean);
if (mailHosts.length > 10 || mailHosts.some(host => !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/u.test(host) ||
    host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal"))) {
  throw new Error("IMAPS egress requires exact normalized public DNS hostnames");
}
const workerHosts = required("AIBRAIN_EGRESS_WORKER_HOSTS").split(",");
if (workerHosts.some((host) => host !== host.trim().toLowerCase() || !EXACT_HOST.test(host) ||
    host === "localhost" || host.endsWith(".localhost"))) {
  throw new Error("AIBRAIN_EGRESS_WORKER_HOSTS must contain exact normalized DNS hostnames");
}

const supabase = new URL(required("AIBRAIN_EGRESS_SUPABASE_ORIGIN"));
if (supabase.protocol !== "https:" || supabase.username || supabase.password || supabase.port ||
    supabase.pathname !== "/" || supabase.search || supabase.hash ||
    supabase.origin !== required("NEXT_PUBLIC_SUPABASE_URL")) {
  throw new Error("Supabase auth URL and server egress origin must be the same exact HTTPS origin");
}

proxy.username = "aibrain";
proxy.password = tokens[2];
process.stdout.write(proxy.href);
