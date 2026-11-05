import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile, ResourceLockManager } from "@/storage";
import { readRegularFileWithin } from "@/security/safe-file";
import JSZip from "jszip";
import { MAX_TRANSLATION_DOCUMENT_BYTES, MAX_TRANSLATION_DOCUMENT_LINES } from "./translation-limits";

// Progress belongs to an authenticated owner, one thread, one specific upload
// and target language. It records authored page content, not translation quality.
export type TranslationSource = Readonly<{ installationId: string; userId: string; threadId: string; uploadId: string; sourceSha256: string; pages: number; targetLanguage: string }>;
export type InspectedPage = Readonly<{ page: number; pages: number; sourceSha256: string; imageSha256: string }>;
type Page = { page: number; imageSha256: string; translation: string; translationSha256: string };
type RecordValue = { schemaVersion: 1; source: TranslationSource; pages: Page[] };
const MAX_RECORD_BYTES = 5_000_000;
const MAX_PAGE_BYTES = 24_000;
const SHA = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export class TranslationProgressError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
function invalid(message: string): never { throw new TranslationProgressError("TRANSLATION_PROGRESS_INVALID", message); }
function canonicalLanguage(value: unknown) {
  if(typeof value!=="string" || value.length>80 || /[\u0000-\u001f\u007f]/u.test(value)) return "";
  const normalized=value.trim().normalize("NFC").replace(/\s+/gu," ").toLowerCase();
  const folded=normalized.normalize("NFKD").replace(/\p{M}/gu,"");
  const aliases: Record<string,string> = {
    es:"es",espanol:"es",castellano:"es",castella:"es",spanish:"es",castilian:"es",
    ca:"ca",catala:"ca",catalan:"ca",
    en:"en",ingles:"en",angles:"en",english:"en",
  };
  return Object.hasOwn(aliases,folded) ? aliases[folded]! : normalized;
}
function canonical(source: TranslationSource): TranslationSource {
  const targetLanguage = canonicalLanguage(source.targetLanguage);
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/u.test(source.installationId) || !UUID.test(source.userId) || !UUID.test(source.threadId) || !UUID.test(source.uploadId) ||
      !SHA.test(source.sourceSha256) || !Number.isSafeInteger(source.pages) || source.pages < 1 || source.pages > 500 ||
      !targetLanguage || targetLanguage.length > 80 || /[\u0000-\u001f\u007f]/u.test(targetLanguage)) invalid("La identidad o el documento no se han podido verificar.");
  return { installationId: source.installationId, userId: source.userId, threadId: source.threadId, uploadId: source.uploadId,
    sourceSha256: source.sourceSha256, pages: source.pages, targetLanguage };
}
function validateText(value: string) {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > MAX_PAGE_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(value))
    invalid("La traducción de la página está vacía, es demasiado larga o contiene caracteres no admitidos.");
  return value.replace(/\r\n?/gu, "\n").trim();
}
export async function verifyTranslatedDocx(bytes: Buffer, title: string, content: string) {
  const archive=await JSZip.loadAsync(bytes);
  const document=archive.file("word/document.xml");
  if(!document) invalid("El Word no contiene el texto esperado.");
  const xml=await document.async("string");
  const paragraphs=xml.match(/<w:p(?:>.*?<\/w:p>|\/>)/gsu) ?? [];
  const text=paragraphs.map(paragraph=>{
    const value=paragraph.match(/<w:t xml:space="preserve">(.*?)<\/w:t>/su)?.[1] ?? "";
    return value.replaceAll("&apos;","'").replaceAll("&quot;",'"').replaceAll("&gt;",">").replaceAll("&lt;","<").replaceAll("&amp;","&");
  });
  const expected=[title,...content.split("\n")].map(value=>value.trim()?value:"");
  if(text.length!==expected.length || text.some((value,index)=>value!==expected[index])) invalid("El Word no conserva todo el texto guardado; no se ha entregado.");
}
function validateRecord(v: unknown, source: TranslationSource): RecordValue {
  if (!object(v) || Object.keys(v).sort().join(",")!=="pages,schemaVersion,source" || v.schemaVersion !== 1 || JSON.stringify(v.source) !== JSON.stringify(source) || !Array.isArray(v.pages) || v.pages.length > source.pages) invalid("El progreso no corresponde al original autorizado.");
  const pages: Page[] = []; const seen = new Set<number>();
  for (const p of v.pages) {
    if (!object(p) || Object.keys(p).sort().join(",")!=="imageSha256,page,translation,translationSha256" || !Number.isSafeInteger(p.page) || (p.page as number) < 1 || (p.page as number) > source.pages || seen.has(p.page as number) ||
        typeof p.imageSha256 !== "string" || !SHA.test(p.imageSha256) || typeof p.translation !== "string" || typeof p.translationSha256 !== "string" ||
        p.translationSha256 !== hash(validateText(p.translation))) invalid("El progreso guardado no supera la comprobación de integridad.");
    seen.add(p.page as number); pages.push({ page: p.page as number, imageSha256: p.imageSha256, translation: p.translation, translationSha256: p.translationSha256 });
  }
  pages.sort((a,b) => a.page-b.page);
  return { schemaVersion: 1, source, pages };
}

export class TranslationProgress {
  readonly source: TranslationSource;
  readonly key: string;
  constructor(readonly stateRoot: string, source: TranslationSource) {
    if (!path.isAbsolute(stateRoot)) invalid("La ubicación del progreso no es segura.");
    this.source = canonical(source);
    this.key = hash(JSON.stringify(this.source));
  }
  private async root() {
    const root = await realpath(this.stateRoot);
    const state=await lstat(root);
    if (root !== path.resolve(this.stateRoot) || !state.isDirectory() || state.isSymbolicLink() || (state.mode & 0o077)!==0) invalid("La ubicación del progreso no es segura.");
    const dir = path.join(root, "document-translation-progress");
    try { await mkdir(dir, {mode:0o700}); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const meta = await lstat(dir);
    if (!meta.isDirectory() || meta.isSymbolicLink() || (meta.mode & 0o077) !== 0 || await realpath(dir) !== dir) invalid("La ubicación del progreso no es privada.");
    return dir;
  }
  private async withRecord<T>(fn: (value: RecordValue, file: string, root: string) => Promise<T>): Promise<T> {
    const root = await this.root();
    const lock = new ResourceLockManager({rootDirectory:path.join(root,"locks")});
    return lock.withLock(`translation:${this.key}`, async () => {
      const name = `${this.key}.json`; let value: RecordValue;
      try {
        const meta=await lstat(path.join(root,name));
        if(!meta.isFile() || meta.isSymbolicLink() || meta.nlink!==1 || (meta.mode & 0o077)!==0) invalid("El progreso guardado no es privado.");
        value = validateRecord(JSON.parse((await readRegularFileWithin(root,name,MAX_RECORD_BYTES)).toString("utf8")), this.source);
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        value = {schemaVersion:1,source:this.source,pages:[]};
      }
      return fn(value,path.join(root,name),root);
    });
  }
  private coverage(value: RecordValue) {
    const saved = value.pages.map(p=>p.page); const seen = new Set(saved);
    const pending = Array.from({length:this.source.pages},(_,i)=>i+1).filter(page=>!seen.has(page));
    return {totalPages:this.source.pages,savedPages:saved,pendingPages:pending.slice(0,50),pendingCount:pending.length,complete:pending.length===0};
  }
  async status() { return this.withRecord(async value=>this.coverage(value)); }
  async page(page: number) {
    if(!Number.isSafeInteger(page) || page<1 || page>this.source.pages) invalid("La página no es válida.");
    return this.withRecord(async value=>{
      const entry=value.pages.find(item=>item.page===page);
      if(!entry) throw new TranslationProgressError("TRANSLATION_PAGE_MISSING","Esta página todavía no tiene una traducción guardada.");
      return {...entry};
    });
  }
  async save(inspection: InspectedPage, translation: string, expectedTranslationSha256?: string) {
    const text = validateText(translation);
    if (!Number.isSafeInteger(inspection.page) || inspection.page < 1 || inspection.page > this.source.pages || inspection.pages !== this.source.pages ||
        inspection.sourceSha256 !== this.source.sourceSha256 || !SHA.test(inspection.imageSha256)) invalid("La página no está vinculada a una inspección de este turno.");
    return this.withRecord(async (value,file,root)=>{
      const index = value.pages.findIndex(p=>p.page===inspection.page);
      const entry: Page = {page:inspection.page,imageSha256:inspection.imageSha256,translation:text,translationSha256:hash(text)};
      if (index >= 0) {
        const previous=value.pages[index]!;
        if (previous.translationSha256===entry.translationSha256 && previous.imageSha256===entry.imageSha256) return this.coverage(value);
        if (!expectedTranslationSha256 || expectedTranslationSha256!==previous.translationSha256) throw new TranslationProgressError("TRANSLATION_PAGE_CONFLICT", "La página cambió o ya tiene otra traducción; lee la versión guardada antes de corregirla.");
        value.pages[index]=entry;
      } else {
        if (expectedTranslationSha256) throw new TranslationProgressError("TRANSLATION_PAGE_CONFLICT", "La página esperada ya no existe; no se ha guardado la corrección.");
        value.pages.push(entry);
      }
      value.pages.sort((a,b)=>a.page-b.page);
      const data = JSON.stringify(value);
      if (Buffer.byteLength(data,"utf8") > MAX_RECORD_BYTES) invalid("El progreso supera el límite de tamaño.");
      await atomicWriteFile(file,data,{mode:0o600});
      const checked = validateRecord(JSON.parse((await readRegularFileWithin(root,path.basename(file),MAX_RECORD_BYTES)).toString("utf8")),this.source);
      if (JSON.stringify(value)!==JSON.stringify(checked)) invalid("No se ha podido comprobar el guardado.");
      return this.coverage(checked);
    });
  }
  async assemble() {
    return this.withRecord(async value=>{
      const coverage = this.coverage(value);
      if (!coverage.complete) throw new TranslationProgressError("TRANSLATION_INCOMPLETE", `Faltan ${coverage.pendingCount} páginas por traducir y guardar.`);
      const text = value.pages.map(p=>`[Página ${p.page}]\n${p.translation}`).join("\n\n");
      if (Buffer.byteLength(text,"utf8") > MAX_TRANSLATION_DOCUMENT_BYTES || text.split("\n").length > MAX_TRANSLATION_DOCUMENT_LINES)
        throw new TranslationProgressError("TRANSLATION_OUTPUT_LIMIT", "La traducción completa supera el límite seguro del generador Word; no se ha entregado una versión truncada.");
      return {text,coverage,sourceSha256:this.source.sourceSha256,targetLanguage:this.source.targetLanguage,contentSha256:hash(text)};
    });
  }
}
