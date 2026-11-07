import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";

export const MULTISOURCE_VERSION = 2;
const SOURCES: Record<string, string[]> = {
  "Air Charter Guide": ["aircharterguide.com", "www.aircharterguide.com"],
  "FAA user-supplied workbook": ["www.faa.gov", "faa.gov"],
  "Aviapages public listing": ["aviapages.com", "www.aviapages.com"],
};
export function sourcingPath(dataRoot: string) {
  if (!path.isAbsolute(dataRoot)) throw Error("Absolute installation data root required");
  if (lstatSync(dataRoot).isSymbolicLink()) throw Error("Data-root symlink denied");
  const directory=path.join(dataRoot,"insijets-multisource-v2");
  if(existsSync(directory)&&lstatSync(directory).isSymbolicLink())throw Error("Store symlink denied");
  return path.join(directory,"public-directory.sqlite");
}
export class OperatorSourcingStore {
  readonly db: DatabaseSync;
  constructor(dataRoot: string) {
    const file=sourcingPath(dataRoot);
    if(!existsSync(file)||!lstatSync(file).isFile()||lstatSync(file).isSymbolicLink())throw Error("Multi-source database is not installed");
    this.db=new DatabaseSync(file,{readOnly:true});
    try {
      if(this.db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()?.value!==String(MULTISOURCE_VERSION))throw Error("Unsupported multi-source schema");
    } catch(error){this.db.close();throw error;}
  }
  close(){this.db.close();}
  summary(){
    return {schemaVersion:MULTISOURCE_VERSION,sourceOperatorEntities:this.db.prepare("SELECT COUNT(*) AS n FROM operators").get()!.n,aircraftObservations:this.db.prepare("SELECT COUNT(*) AS n FROM aircraft").get()!.n,uniqueEmails:this.db.prepare("SELECT COUNT(DISTINCT email) AS n FROM contacts").get()!.n,sourceCounts:this.db.prepare("SELECT source, COUNT(*) AS records FROM operators GROUP BY source ORDER BY source").all(),availability:"Unconfirmed; operator reply required",sendEnabled:false};
  }
  browse(filters: {query?:string;airport?:string;country?:string;minSeats?:number;limit?:number;page?:number}={}) {
    const limit=filters.limit??30,page=filters.page??1;
    if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(page)||page<1||page>10000)throw Error("Invalid pagination");
    const where:string[]=[],args:(string|number)[]=[];
    for(const [value,clause] of [[filters.query,"(o.name LIKE ? ESCAPE '\\' OR a.model LIKE ? ESCAPE '\\' OR a.registration LIKE ? ESCAPE '\\')"],[filters.airport,"b.airport = ?"],[filters.country,"b.country = ?"]] as const){
      if(!value)continue;if(value.length>200||/[\u0000-\u001f]/.test(value))throw Error("Invalid filter");
      where.push(clause);
      if(value===filters.query&&clause.startsWith("(")){const match='%'+value.replace(/[\\%_]/g,"\\$&")+'%';args.push(match,match,match);}else args.push(value);
    }
    if(filters.minSeats!==undefined){if(!Number.isInteger(filters.minSeats)||filters.minSeats<1||filters.minSeats>500)throw Error("Invalid seats");where.push("a.seats >= ?");args.push(filters.minSeats);}
    const join=" FROM aircraft a JOIN operators o ON o.id=a.operator_id JOIN bases b ON b.id=a.base_id AND b.operator_id=a.operator_id";
    const predicate=where.length?" WHERE "+where.join(" AND "):"";
    const total=this.db.prepare("SELECT COUNT(*) AS n"+join+predicate).get(...args)!.n;
    const rows=this.db.prepare("SELECT a.id,a.operator_id,o.name AS operator,b.airport,b.country,b.city,a.model,a.seats,a.category,a.registration,a.source,a.source_url,a.checked_at,a.availability"+join+predicate+" ORDER BY o.name,a.model,a.id LIMIT ? OFFSET ?").all(...args,limit,(page-1)*limit);
    return {total,page,limit,rows};
  }
  browseOperators(query="",limit=30,page=1){
    if(query.length>200||/[\u0000-\u001f]/.test(query)||!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(page)||page<1||page>10000)throw Error("Invalid operator filter");
    const value='%'+query.replace(/[\\%_]/g,"\\$&")+'%';
    return {total:this.db.prepare("SELECT COUNT(*) AS n FROM operators WHERE name LIKE ? ESCAPE '\\'").get(value)!.n,page,limit,rows:this.db.prepare("SELECT id,name,country,city,phone,website,source,source_url,checked_at,identity_status FROM operators WHERE name LIKE ? ESCAPE '\\' ORDER BY name,id LIMIT ? OFFSET ?").all(value,limit,(page-1)*limit)};
  }
  planningDataset(){return Object.fromEntries(["operators","bases","aircraft","contacts"].map(table=>[table,this.db.prepare(`SELECT * FROM ${table}`).all()]));}
}

/** Operator-only installation adapter. No request-controlled file paths or overwrites.
 * A digest must come from the reviewed delivery receipt, not from the same upload.
 */
export function installMultisourceDatabase(input:{sourceFile:string;expectedSha256:string;dataRoot:string;installationId:string;confirmation:string}){
  if(input.installationId!=="insijets-demo"||input.confirmation!=="INSTALL INSIJETS MULTISOURCE V2")throw Error("Explicit InsiJets installation confirmation required");
  if(!/^[a-f0-9]{64}$/.test(input.expectedSha256)||!path.isAbsolute(input.sourceFile))throw Error("Reviewed digest and absolute source required");
  const st=lstatSync(input.sourceFile);if(!st.isFile()||st.isSymbolicLink()||st.size>64*1024*1024)throw Error("Source must be a regular database under 64 MiB");
  const hash=(file:string)=>createHash("sha256").update(readFileSync(file)).digest("hex");
  if(hash(input.sourceFile)!==input.expectedSha256)throw Error("Source digest mismatch");
  const source=new DatabaseSync(input.sourceFile,{readOnly:true});
  try{
    if(source.prepare("PRAGMA integrity_check").get()!.integrity_check!=="ok")throw Error("Source integrity check failed");
    if(source.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()?.value!=="2")throw Error("Unsupported schema");
    for(const table of ["operators","bases","aircraft","contacts"]){
      const totals=source.prepare(`SELECT COUNT(*) AS total,COUNT(DISTINCT id) AS unique_ids FROM ${table}`).get()!;
      if(totals.total!==totals.unique_ids)throw Error("Duplicate source identifiers");
      for(const row of source.prepare(`SELECT id,source,source_url FROM ${table}`).all()){
        const url=new URL(row.source_url as string),allowed=SOURCES[row.source as string];
        if(!allowed||url.protocol!=="https:"||url.username||url.password||!allowed.includes(url.hostname))throw Error("Unknown source provenance");
        const prefix=row.source==="Air Charter Guide"?"acg:":row.source==="FAA user-supplied workbook"?"faa:":"aviapages:";
        if(!(row.id as string).startsWith(prefix))throw Error("Source identifier mismatch");
      }
      if((source.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n as number)>50000)throw Error("Source entity limit exceeded");
    }
    if(source.prepare("SELECT COUNT(*) AS n FROM aircraft a LEFT JOIN bases b ON b.id=a.base_id LEFT JOIN operators o ON o.id=a.operator_id WHERE b.id IS NULL OR o.id IS NULL OR b.operator_id<>a.operator_id").get()!.n!==0)throw Error("Orphan aircraft relationship");
    if(source.prepare("SELECT COUNT(*) AS n FROM bases b LEFT JOIN operators o ON o.id=b.operator_id WHERE o.id IS NULL").get()!.n!==0)throw Error("Orphan base relationship");
    if(source.prepare("SELECT COUNT(*) AS n FROM contacts c LEFT JOIN operators o ON o.id=c.operator_id LEFT JOIN bases b ON b.id=c.base_id WHERE o.id IS NULL OR (c.base_id<>'' AND (b.id IS NULL OR b.operator_id<>c.operator_id))").get()!.n!==0)throw Error("Orphan contact relationship");
  }finally{source.close();}
  const target=sourcingPath(input.dataRoot),directory=path.dirname(target);
  mkdirSync(directory,{recursive:true,mode:0o700});
  if(existsSync(target)){
    if(lstatSync(target).isSymbolicLink()||hash(target)!==input.expectedSha256)throw Error("Existing multi-source database preserved. Reviewed migration required.");
    return {repeated:true,sha256:input.expectedSha256,schemaVersion:2};
  }
  const temporary=path.join(directory,`import-${process.pid}.tmp`);
  if(existsSync(temporary))throw Error("Temporary import path already exists");
  try{copyFileSync(input.sourceFile,temporary);chmodSync(temporary,0o600);if(hash(temporary)!==input.expectedSha256)throw Error("Copied digest mismatch");linkSync(temporary,target);}finally{if(existsSync(temporary))unlinkSync(temporary);}
  return {repeated:false,sha256:input.expectedSha256,schemaVersion:2};
}
