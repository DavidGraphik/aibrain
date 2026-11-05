/** Seed two synthetic files through the authenticated, real upload/preview route. */
import { request, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { generateLocalDocument } from "../src/runtime/documents/local-document-generator";

async function main() {
  const root = process.argv[2];
  if (!root || !path.isAbsolute(root) || !path.basename(root).startsWith("aibrain-joined-qa-")) throw new Error("Use the joined QA root");
  const origin = "https://127.0.0.1:3196";
  const api = await request.newContext({ ignoreHTTPSErrors: true, storageState: path.join(root, "storage-0.json"), extraHTTPHeaders: { Origin: origin } });
  try {
    const response = await api.get(`${origin}/api/threads`);
    expect(response.ok()).toBe(true);
    const thread = (await response.json()).threads.find((item: { title: string }) => item.title === "Browser fixture");
    const evidence = [];
    const fixtures = [];
    for (const format of ["pdf", "xlsx"] as const) {
      const file = await generateLocalDocument({ format, title: "Joined QA document", content: "Synthetic preview evidence 42", ...(format === "xlsx" ? { rows: [["Name", "Value"], ["Evidence", 42]] } : {}) });
      const filePath = path.join(root, `fixture.${format}`);
      await writeFile(filePath, file.data, { mode: 0o600 });
      fixtures.push({ format, filePath, mimeType: file.mimeType });
    }
    for (const { format, filePath, mimeType } of fixtures) {
      const upload = await api.post(`${origin}/api/threads/${thread.id}/documents`, { multipart: { uploadId: randomUUID(), file: { name: `fixture.${format}`, mimeType, buffer: await readFile(filePath) } } });
      const result = await upload.json();
      evidence.push({ format, status: upload.status(), result });
      await writeFile(path.join(root, "documents.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
      expect(upload.ok(), JSON.stringify(result)).toBe(true);
    }
    console.log(JSON.stringify({ passed: true, formats: ["pdf", "xlsx"], root, gate: "real authenticated upload/preview, UI still requires QA" }));
  } finally { await api.dispose(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
