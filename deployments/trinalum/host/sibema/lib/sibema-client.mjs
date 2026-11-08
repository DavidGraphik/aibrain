import {sibemaOrigin as DEFAULT_HOST,sibemaApiBase} from './provider-config.mjs';

export class SibemaClient {
  constructor({
    host = process.env.SIBEMA_HOST ?? DEFAULT_HOST,
    username = process.env.SIBEMA_USERNAME,
    password = process.env.SIBEMA_PASSWORD,
    fetchImpl = fetch,
  } = {}) {
    if (!username || !password) throw new Error("SIBEMA_USERNAME and SIBEMA_PASSWORD are required");
    this.host = host.replace(/\/+$/, "");
    if (this.host !== DEFAULT_HOST) throw new Error("SIBEMA origin must match protected installation configuration");
    this.username = username;
    this.password = password;
    this.fetchImpl = fetchImpl;
    this.base = sibemaApiBase;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  async authenticate() {
    if (this.authenticationPromise) return this.authenticationPromise;
    this.authenticationPromise = this.authenticateOnce().finally(()=>{this.authenticationPromise=null;});
    return this.authenticationPromise;
  }

  async authenticateOnce() {
    let lastError;
    for (let attempt=0;attempt<2;attempt++) {
      try { return await this.performAuthentication(); }
      catch(error) {lastError=error;if(!['TimeoutError','TypeError','AbortError'].includes(error.name) && !(error.status>=500)) throw error;}
    }
    throw lastError;
  }

  async performAuthentication() {
    const response = await this.fetchImpl(`${this.host}/ERPBerma/authenticate`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ username: this.username, password: this.password }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => ({}));
    const token = body.jwttoken ?? body.token;
    if (!response.ok || typeof token !== "string" || !token ||
        (body.jwttoken && body.token && body.jwttoken !== body.token)) {
      const error=new Error(`SIBEMA authentication failed (${response.status})`);error.status=response.status;throw error;
    }
    this.token = token;
    this.tokenExpiresAt = jwtExpiry(token) ?? Date.now() + 4.5 * 60 * 60 * 1000;
  }

  async request(path, options = {}, retry = true) {
    if (!this.token || Date.now() > this.tokenExpiresAt - 60_000) await this.authenticate();
    const response = await this.fetchImpl(`${this.base}${path}`, {
      ...options,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/json",
        ...(options.headers ?? {}),
      },
      redirect: "error",
      signal: options.signal ?? AbortSignal.timeout(15_000),
    });

    if (response.status === 401 && retry) {
      this.token = null;
      await this.authenticate();
      return this.request(path, options, false);
    }

    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!response.ok) {
      const error = new Error(`SIBEMA ${options.method ?? "GET"} ${path} failed (${response.status})`);
      if (body && typeof body === "object") {
        error.message += `: ${String(body.message ?? body.detail ?? "").slice(0,1000)}`;
        error.code = body.code ?? null;
      }
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  }

  async get(path) {
    try {return await this.request(path);}
    catch(error) {
      if (!['TimeoutError','TypeError','AbortError'].includes(error.name) && !(error.status>=500)) throw error;
      return this.request(path);
    }
  }

  getObject(resource, objectId) {
    return this.get(`/${resource}/${encodeURIComponent(objectId)}`);
  }

  async getContract() {
    if (!this.token || Date.now() > this.tokenExpiresAt - 60_000) await this.authenticate();
    const response = await this.fetchImpl(`${this.host}/ERPBerma/v3/api-docs`, {
      headers: { authorization: `Bearer ${this.token}`, accept: "application/json" },
      redirect: "error", signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`SIBEMA contract read failed (${response.status})`);
    const bytes = await boundedBytes(response, 8 * 1024 * 1024);
    const contract = JSON.parse(bytes.toString("utf8"));
    if (!contract.openapi || !contract.paths) throw new Error("Invalid SIBEMA contract");
    return contract;
  }

  async getBinary(path) {
    if (!/^\/offers\/\d+\/files\/\d+\/content$/.test(path)) throw new Error("Only native offer PDF downloads are permitted");
    if (!this.token || Date.now() > this.tokenExpiresAt - 60_000) await this.authenticate();
    const response = await this.fetchImpl(`${this.base}${path}`, {
      headers: { authorization: `Bearer ${this.token}`, accept: "application/pdf" },
      redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`SIBEMA PDF readback failed (${response.status})`);
    const bytes = await boundedBytes(response, 15 * 1024 * 1024);
    if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("SIBEMA attachment is not a PDF");
    return bytes;
  }

  write(path, { method, body, idempotencyKey }) {
    if (!["POST", "PUT", "PATCH"].includes(method)) {
      throw new Error("SIBEMA writes require POST, PUT or PATCH");
    }
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length < 8) {
      throw new Error("A stable Idempotency-Key is required");
    }
    return this.request(path, {
      method,
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": idempotencyKey.trim(),
      },
      body: JSON.stringify(body),
    });
  }

  async listAll(resource, query = {}) {
    const output = [];
    let page = Number(query.page ?? 0);
    do {
      const params = new URLSearchParams({ ...query, page: String(page), size: String(Math.min(Number(query.size ?? 200), 200)) });
      const result = await this.get(`/${resource}?${params}`);
      if (Array.isArray(result)) return result;
      output.push(...(result?.data ?? []));
      if (!result?.has_next) return output;
      page += 1;
    } while (page < 10_000);
    throw new Error(`Pagination safety limit reached for ${resource}`);
  }
}

function jwtExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function boundedBytes(response, maxBytes) {
  if (Number(response.headers.get("content-length")) > maxBytes) throw new Error("SIBEMA response exceeds byte limit");
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks=[]; let count=0;
  try {
    while (true) {const {done,value}=await reader.read();if(done) break;count+=value.byteLength;if(count>maxBytes) throw new Error("SIBEMA response exceeds byte limit");chunks.push(Buffer.from(value));}
    return Buffer.concat(chunks,count);
  } catch(error) {await reader.cancel().catch(()=>{});throw error;}
  finally {reader.releaseLock();}
}
