import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "@/storage";
import { readRegularFileWithin } from "@/security/safe-file";
import { CompanyMailError } from "./company-mail-contracts";
import { MAIL_HASH } from "./company-mail-store";

/** A future Windows publisher can implement this boundary without changing IMAP
 * receipts or review state. It must retain immutable originals and verify writes.
 * No Windows transport is enabled by the current implementation. */
export interface MailInvoiceDestination {
  readonly kind: string;
  putOriginal(sha256: string, contents: Buffer): Promise<void>;
  readOriginal(sha256: string): Promise<Buffer>;
  putWorkbook(contents: Buffer): Promise<void>;
}
function missing(error: unknown) { return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"); }
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");

export class HetznerMailInvoiceDestination implements MailInvoiceDestination {
  readonly kind = "aibrain-private-volume";
  constructor(readonly root: string, readonly maximumOriginalBytes = 20 * 1024 * 1024) {}
  private originalPath(sha256: string) {
    if (!MAIL_HASH.test(sha256)) throw new CompanyMailError("MAIL_ORIGINAL_ID_INVALID", "Original no válido.");
    return path.posix.join("originals", sha256);
  }
  async readOriginal(sha256: string) {
    const contents = await readRegularFileWithin(this.root, this.originalPath(sha256), this.maximumOriginalBytes);
    if (hash(contents) !== sha256) throw new CompanyMailError("MAIL_ORIGINAL_CHANGED", "El original no coincide con su registro.");
    return contents;
  }
  async putOriginal(sha256: string, contents: Buffer) {
    if (contents.length > this.maximumOriginalBytes || hash(contents) !== sha256) throw new CompanyMailError("MAIL_ORIGINAL_INVALID", "Original no válido.");
    try {
      const existing = await this.readOriginal(sha256);
      if (!existing.equals(contents)) throw new CompanyMailError("MAIL_ORIGINAL_CHANGED", "Conflicto con el original almacenado.");
    } catch (error) {
      if (!missing(error)) throw error;
      await atomicWriteFile(path.join(this.root, this.originalPath(sha256)), contents, { mode: 0o600 });
    }
  }
  async putWorkbook(contents: Buffer) {
    const target = path.join(this.root, "facturas.xlsx");
    try {
      const metadata = await lstat(target);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new CompanyMailError("MAIL_PATH_UNSAFE", "Destino de Excel no seguro.");
    } catch (error) { if (!missing(error)) throw error; }
    await atomicWriteFile(target, contents, { mode: 0o600 });
  }
}
