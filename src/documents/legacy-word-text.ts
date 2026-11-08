import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { atomicWriteFile } from "@/storage/atomic-file";
import { readRegularFileWithin } from "@/security/safe-file";
import { SystemDocumentToolRunner, type DocumentToolRunner } from "./preview-service";
import type { DocumentConversionAdmission } from "./conversion-gate";

const MAX_TEXT = 2 * 1024 * 1024;
const SECRET = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*|\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|password)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{16,}/i;

/** Passive text reading of an already ACL/hash-verified original in the existing document sandbox. */
export async function legacyWordText(bytes: Buffer, options: {
  conversionGate: DocumentConversionAdmission; runner?: DocumentToolRunner; soffice?: string; signal?: AbortSignal;
}): Promise<string> {
  if (bytes.length > 16 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex")) ||
      !bytes.includes(Buffer.from("WordDocument\0", "utf16le"))) throw new Error("SERVER_WORD_FORMAT_INVALID");
  const soffice = options.soffice ?? process.env.AIBRAIN_SOFFICE_BIN;
  if (soffice !== "/usr/local/bin/aibrain-soffice") throw new Error("SERVER_WORD_SANDBOX_UNAVAILABLE");
  return options.conversionGate.run(async () => {
    const work = await mkdtemp(path.join(tmpdir(), "aibrain-turn-document-"));
    try {
      const source = path.join(work, "source.doc");
      await atomicWriteFile(source, bytes, { mode: 0o600 });
      await (options.runner ?? new SystemDocumentToolRunner()).run(soffice, [
        `-env:UserInstallation=file://${path.join(work, "lo-profile")}`,
        "--headless", "--invisible", "--nologo", "--nodefault", "--nofirststartwizard", "--norestore", "--safe-mode",
        "--infilter=MS Word 97", "--convert-to", "txt:Text (encoded):UTF8", "--outdir", work, source,
      ], { cwd: work, env: { HOME: work, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", SAL_USE_VCLPLUGIN: "svp" }, timeoutMs: 60_000, signal: options.signal });
      const output = await readRegularFileWithin(work, "source.txt", MAX_TEXT);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(output).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
      if (!text || Buffer.byteLength(text) > MAX_TEXT || /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(text) || SECRET.test(text)) throw new Error("SERVER_WORD_TEXT_REJECTED");
      return text;
    } finally { await rm(work, { recursive: true, force: true }); }
  }, { signal: options.signal });
}
