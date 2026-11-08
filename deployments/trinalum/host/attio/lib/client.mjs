const DEFAULT_BASE_URL = "https://api.attio.com/v2";

export class AttioClient {
  constructor(options = {}) {
    this.token = options.token ?? process.env.ATTIO_API_TOKEN?.trim();
    this.baseUrl = (options.baseUrl ?? process.env.ATTIO_API_BASE_URL?.trim() ?? DEFAULT_BASE_URL)
      .replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (!this.token) throw new Error("ATTIO_API_TOKEN is required");
  }

  async request(method, pathname, body = undefined, options = {}) {
    const maxAttempts = options.maxAttempts ?? 6;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const raw = await response.text();
      const parsed = raw ? safeJson(raw) : {};
      if (response.ok) return parsed;
      if ((response.status === 429 || response.status >= 500) && attempt + 1 < maxAttempts) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.max(500, retryAfter * 1000)
          : Math.min(10000, 500 * 2 ** attempt);
        await sleep(delayMs);
        continue;
      }
      const error = new Error(
        parsed?.message ||
          parsed?.error?.message ||
          `${method} ${pathname} failed with HTTP ${response.status}`,
      );
      error.status = response.status;
      error.code = parsed?.code ?? parsed?.error?.code ?? null;
      error.payload = parsed;
      throw error;
    }
    throw new Error(`Attio request failed after ${maxAttempts} attempts`);
  }

  get(pathname) {
    return this.request("GET", pathname);
  }

  post(pathname, body) {
    return this.request("POST", pathname, body);
  }

  put(pathname, body) {
    return this.request("PUT", pathname, body);
  }

  async listNotes(filters={}) {
    const notes=[];
    for(let offset=0;offset<10000;offset+=50){
      const response=await this.get('/notes?'+new URLSearchParams({...filters,limit:'50',offset:String(offset)}));
      const page=response.data??[];notes.push(...page);if(page.length<50)return notes;
    }
    throw new Error('Note pagination limit reached; coverage incomplete');
  }

  async listTasks(filters={}) {
    const rows=[];
    for(let offset=0;offset<10000;offset+=100){
      const response=await this.get('/tasks?'+new URLSearchParams({...filters,limit:'100',offset:String(offset)}));
      const page=response.data??[];rows.push(...page);if(page.length<100)return rows;
    }
    throw new Error('Task pagination limit reached; coverage incomplete');
  }

  async listRecords(objectSlug) {
    const records = [];
    let offset = 0;
    while (true) {
      const response = await this.post(`/objects/${encodeURIComponent(objectSlug)}/records/query`, {
        limit: 500,
        offset,
      });
      const page = response.data ?? [];
      records.push(...page);
      if (page.length < 500) return records;
      offset += page.length;
    }
  }

  async listEntries(listSlug) {
    const entries = [];
    let offset = 0;
    while (true) {
      const response = await this.post(`/lists/${encodeURIComponent(listSlug)}/entries/query`, {
        limit: 500,
        offset,
      });
      const page = response.data ?? [];
      entries.push(...page);
      if (page.length < 500) return entries;
      offset += page.length;
    }
  }
}

export function currentValue(record, attributeSlug) {
  const values =
    record?.values?.[attributeSlug] ??
    record?.entry_values?.[attributeSlug] ??
    [];
  return values.find((item) => item.active_until === null) ?? values[0] ?? null;
}

export function currentText(record, attributeSlug) {
  const value = currentValue(record, attributeSlug);
  return String(
    value?.value ??
      value?.full_name ??
      value?.title ??
      value?.email_address ??
      value?.original_email_address ??
      "",
  ).trim();
}

function safeJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return { message: raw.slice(0, 1000) };
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
