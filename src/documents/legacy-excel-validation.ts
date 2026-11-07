import { UploadValidationError } from "./upload-validation";
import { inspectAutoFilterDrawings, type FilterSheet } from "./legacy-excel-autofilter";

const SIGNATURE = Buffer.from("d0cf11e0a1b11ae1", "hex");
export function isLegacyExcelContainer(data: Buffer) {
  return data.subarray(0, 8).equals(SIGNATURE);
}
function reject(code = "UPLOAD_OFFICE_INVALID"): never {
  throw new UploadValidationError(code, "Legacy workbook failed bounded structural validation.");
}

/** Bounded CFB graph reader. Passive callers receive only the root Workbook stream. */
function readLegacyContainer(data: Buffer, passive: boolean, storageOnly = false) {
  if (data.length > 16 * 1024 * 1024) reject("UPLOAD_SIZE_INVALID");
  if (data.length < 512 || !isLegacyExcelContainer(data)) reject();
  // Excel 97-2003 uses CFB v3, 512-byte sectors and 64-byte mini sectors.
  if (data.readUInt16LE(26) !== 3 || data.readUInt16LE(28) !== 0xfffe ||
      data.readUInt16LE(30) !== 9 || data.readUInt16LE(32) !== 6 ||
      data.readUInt32LE(56) !== 4096 || data.length % 512 !== 0) reject();
  const sectors = data.length / 512 - 1;
  const sector = (id: number) => {
    if (id < 0 || id >= sectors) reject();
    return data.subarray((id + 1) * 512, (id + 2) * 512);
  };
  const fatIds: number[] = [];
  const addFatIds = (bytes: Buffer, count: number) => {
    for (let i = 0; i < count; i++) {
      const id = bytes.readInt32LE(i * 4);
      if (id !== -1) { sector(id); fatIds.push(id); }
    }
  };
  addFatIds(data.subarray(76, 512), 109);
  let difatId = data.readInt32LE(68);
  const difatSeen = new Set<number>();
  const difatCount = data.readUInt32LE(72);
  if (difatCount > sectors) reject();
  for (let i = 0; i < difatCount; i++) {
    if (difatSeen.has(difatId)) reject();
    difatSeen.add(difatId);
    const bytes = sector(difatId);
    addFatIds(bytes, 127);
    difatId = bytes.readInt32LE(508);
  }
  if (difatCount && difatId !== -2) reject();
  if (fatIds.length !== data.readUInt32LE(44) || new Set(fatIds).size !== fatIds.length) reject();
  const fat = Buffer.concat(fatIds.map(sector));
  const occupied = new Set([...fatIds, ...difatSeen]);
  const chain = (start: number, table: Buffer, read: (id: number) => Buffer, limit: number, claimed: Set<number>) => {
    const parts: Buffer[] = [];
    let id = start;
    while (id !== -2) {
      if (id < 0 || id >= limit || id * 4 + 4 > table.length || claimed.has(id)) reject();
      claimed.add(id);
      parts.push(read(id));
      id = table.readInt32LE(id * 4);
    }
    return Buffer.concat(parts);
  };
  const directory = chain(data.readInt32LE(48), fat, sector, sectors, occupied);
  if (directory.length / 128 > 5000) reject();
  // Validate the directory graph before any downstream Office parser sees it.
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const parents = new Map<number, number>();
  const stack: [number, boolean, number][] = [[0, false, -1]];
  while (stack.length) {
    const [id, leaving, parent] = stack.pop()!;
    if (leaving) { visiting.delete(id); visited.add(id); continue; }
    if (id === -1) continue;
    if (id < 0 || id >= directory.length / 128 || visiting.has(id) || visited.has(id)) reject();
    if (directory[id * 128 + 66] === 0) reject();
    const type = directory[id * 128 + 66];
    if (type === 2 && directory.readInt32LE(id * 128 + 76) !== -1) reject();
    if (id === 0 && (directory.readInt32LE(68) !== -1 || directory.readInt32LE(72) !== -1)) reject();
    visiting.add(id);
    parents.set(id, parent);
    stack.push([id, true, parent]);
    for (const field of [68, 72, 76]) stack.push([directory.readInt32LE(id * 128 + field), false, field === 76 ? id : parent]);
  }
  const entries: { name: string; type: number; start: number; size: number; parent: number }[] = [];
  for (let offset = 0; offset < directory.length; offset += 128) {
    const type = directory[offset + 66]!;
    if (type === 0) continue;
    if (!visited.has(offset / 128)) reject();
    const length = directory.readUInt16LE(offset + 64);
    if (length < 2 || length > 64 || length % 2 || directory.readUInt16LE(offset + length - 2) !== 0 ||
        directory.readUInt32LE(offset + 124) !== 0) reject();
    entries.push({ name: directory.subarray(offset, offset + length - 2).toString("utf16le"), type, parent: parents.get(offset / 128)!,
      start: directory.readInt32LE(offset + 116), size: directory.readUInt32LE(offset + 120) });
  }
  const root = entries[0];
  if (!root || root.type !== 5 || root.size > data.length) reject();
  const miniStream = root.size ? chain(root.start, fat, sector, sectors, occupied).subarray(0, root.size) : Buffer.alloc(0);
  const miniFatCount = data.readUInt32LE(64);
  if (miniFatCount > sectors) reject();
  const miniFat = miniFatCount ? chain(data.readInt32LE(60), fat, sector, sectors, occupied) : Buffer.alloc(0);
  if (miniFat.length !== miniFatCount * 512) reject();
  const miniOccupied = new Set<number>();
  let workbook: Buffer | undefined;
  let opaqueStreams = 0;
  let storages = 0;
  for (const entry of entries.slice(1)) {
    const lower = entry.name.toLowerCase();
    if (passive && entry.type === 1) {
      if (entry.size !== 0) reject();
      storages += 1;
      continue;
    }
    if (entry.type !== 2 || (!passive && !["workbook", "\u0005summaryinformation", "\u0005documentsummaryinformation", "\u0001compobj", "\u0001ole"].includes(lower))) {
      reject("UPLOAD_MACROS_REJECTED");
    }
    if (entry.size > data.length) reject();
    const bytes = entry.size === 0 ? Buffer.alloc(0) : entry.size < 4096
      ? chain(entry.start, miniFat, (id) => miniStream.subarray(id * 64, (id + 1) * 64), Math.floor(miniStream.length / 64), miniOccupied)
      : chain(entry.start, fat, sector, sectors, occupied);
    const unit = entry.size < 4096 ? 64 : 512;
    if (bytes.length !== Math.ceil(entry.size / unit) * unit) reject();
    // Root metadata emitted by Excel/LibreOffice is not an embedded object.
    // Linked OLE metadata and foreign application descriptors remain rejected.
    if (!passive && lower === "\u0001ole" && (entry.size !== 20 || bytes.readUInt32LE(0) !== 0x02000001 ||
        !bytes.subarray(4, 20).every(byte => byte === 0))) reject("UPLOAD_MACROS_REJECTED");
    if (!passive && lower === "\u0001compobj" && (entry.size < 28 || entry.size > 4096 ||
        !["1008020000000000c000000000000046", "2008020000000000c000000000000046"].includes(bytes.subarray(12, 28).toString("hex")))) reject();
    if ((lower === "workbook" || (storageOnly && lower === "book")) && (!passive || entry.parent === 0)) {
      if (workbook) reject();
      workbook = bytes.subarray(0, entry.size);
    } else opaqueStreams += 1;
  }
  if (!workbook || workbook.length < 12 || workbook.readUInt16LE(0) !== 0x0809 ||
      workbook.readUInt16LE(2) < 8 || !(storageOnly ? [0x0500, 0x0600] : [0x0600]).includes(workbook.readUInt16LE(4)) ||
      workbook.readUInt16LE(6) !== 0x0005) reject();
  return { workbook, opaqueStreams, storages };
}

/** Storage admission only. Opaque streams never enter a worker or Office tool.
 * CFB graph, sizes and workbook identity stay bounded, independently of whether
 * our processors support its formulas, macros, encryption or BIFF version. */
export function inspectLegacyExcelForStorage(data: Buffer): void {
  const { workbook } = readLegacyContainer(data, true, true);
  for (let offset = 0; offset < workbook.length;) {
    if (workbook.subarray(offset).every(byte => byte === 0)) break;
    if (offset + 4 > workbook.length) reject();
    const id = workbook.readUInt16LE(offset), size = workbook.readUInt16LE(offset + 2);
    if (size > 8224 || offset + 4 + size > workbook.length) reject();
    if (id === 0x01b8 && size < 32) reject();
    // Encrypted payload is opaque storage, never a reader/converter input.
    if (id === 0x002f) return;
    offset += 4 + size;
  }
}

/** This is not upload admission: callers must use the isolated passive reader. */
export function readPassiveLegacyExcelContainer(data: Buffer) {
  const container = readLegacyContainer(data, true);
  const workbook = container.workbook;
  let depth = 0;
  let substreams = 0;
  for (let offset = 0; offset < workbook.length;) {
    if (depth === 0 && offset > 0 && workbook.subarray(offset).every(byte => byte === 0)) break;
    if (offset + 4 > workbook.length) reject();
    const id = workbook.readUInt16LE(offset), size = workbook.readUInt16LE(offset + 2);
    if (size > 8224 || offset + 4 + size > workbook.length) reject();
    const body = offset + 4;
    if (id === 0x002f) reject("UPLOAD_ENCRYPTED_REJECTED");
    if (id === 0x0809) {
      if (size < 8 || depth !== 0 || ++substreams > 301 || workbook.readUInt16LE(body) !== 0x0600 ||
          ![0x0005, 0x0010, 0x0020, 0x0040].includes(workbook.readUInt16LE(body + 2))) reject();
      depth = 1;
    } else if (id === 0x000a) {
      if (size !== 0 || depth !== 1) reject();
      depth = 0;
    } else if (!depth) reject();
    if (id === 0x01b8 && size < 32) reject();
    offset = body + size;
  }
  if (depth !== 0 || substreams < 2) reject();
  return container;
}

/** Bounded CFB/BIFF8 inspection. Only inert workbook and property streams are admitted. */
export function inspectLegacyExcel(data: Buffer) {
  const { workbook } = readLegacyContainer(data, false);
  let depth = 0;
  let sheets = 0;
  const filterSheets: FilterSheet[] = [];
  const sheetsWithFilterInfo = new Set<FilterSheet>();
  const drawingGroups: Buffer[] = [];
  let filterSheet: FilterSheet | undefined;
  let globalSubstream = false;
  let globalSubstreams = 0;
  let pendingDrawing: Buffer | undefined;
  let previousRecord: number | undefined;
  let unsupportedDrawingTopology = false;
  let hasObjects = false;
  for (let offset = 0; offset < workbook.length;) {
    // Some writers pad the workbook stream with zeros after the final EOF.
    if (depth === 0 && offset > 0 && workbook.subarray(offset).every((byte) => byte === 0)) break;
    if (offset + 4 > workbook.length) reject();
    const id = workbook.readUInt16LE(offset);
    const size = workbook.readUInt16LE(offset + 2);
    if (size > 8224 || offset + 4 + size > workbook.length) reject();
    const body = offset + 4;
    if (id === 0x002f) reject("UPLOAD_ENCRYPTED_REJECTED"); // FILEPASS
    if ([0x00d3, 0x01ba, 0x01b8].includes(id)) reject("UPLOAD_MACROS_REJECTED"); // VBA/CodeName/HLINK
    if (pendingDrawing && id !== 0x005d) {
      unsupportedDrawingTopology = true;
      pendingDrawing = undefined;
    }
    if (id === 0x003c && previousRecord !== undefined && [0x00eb, 0x00ec, 0x005d].includes(previousRecord)) {
      unsupportedDrawingTopology = true; // this profile has no continued object/drawing payload
    }
    if (id === 0x0809) {
      if (size < 8 || workbook.readUInt16LE(body) !== 0x0600 ||
          ![0x0005, 0x0010].includes(workbook.readUInt16LE(body + 2))) reject("UPLOAD_MACROS_REJECTED");
      if (++depth !== 1) reject();
      globalSubstream = workbook.readUInt16LE(body + 2) === 0x0005;
      if (globalSubstream) globalSubstreams += 1;
      filterSheet = globalSubstream ? undefined : { filterColumns: 0, pairs: [] };
      if (filterSheet) filterSheets.push(filterSheet);
    } else if (id === 0x000a) {
      if (size !== 0 || --depth !== 0) reject();
      filterSheet = undefined;
      globalSubstream = false;
    } else if (!depth) reject();
    if (id === 0x0085) {
      if (size < 8 || workbook[body + 5] !== 0 || ++sheets > 100) reject("UPLOAD_MACROS_REJECTED");
      const target = workbook.readUInt32LE(body);
      if (target + 8 > workbook.length || workbook.readUInt16LE(target) !== 0x0809 ||
          workbook.readUInt16LE(target + 6) !== 0x0010) reject();
    }
    if (id === 0x009d) {
      if (!filterSheet || size !== 2 || sheetsWithFilterInfo.has(filterSheet)) unsupportedDrawingTopology = true;
      else {
        sheetsWithFilterInfo.add(filterSheet);
        filterSheet.filterColumns = workbook.readUInt16LE(body);
      }
    }
    if (id === 0x00eb) {
      if (!globalSubstream || drawingGroups.length !== 0) unsupportedDrawingTopology = true;
      drawingGroups.push(workbook.subarray(body, body + size));
    }
    if (id === 0x00ec) {
      if (!filterSheet) unsupportedDrawingTopology = true;
      pendingDrawing = workbook.subarray(body, body + size);
    }
    if (id === 0x005d) {
      hasObjects = true;
      if (!filterSheet || !pendingDrawing || previousRecord !== 0x00ec || filterSheet.pairs.length >= 256) {
        reject("UPLOAD_MACROS_REJECTED");
      }
      filterSheet.pairs.push({ drawing: pendingDrawing, object: workbook.subarray(body, body + size) });
      pendingDrawing = undefined;
    }
    previousRecord = id;
    offset = body + size;
  }
  if (depth !== 0 || sheets < 1) reject();
  if (hasObjects) {
    if (unsupportedDrawingTopology || pendingDrawing || drawingGroups.length !== 1 || globalSubstreams !== 1) reject("UPLOAD_MACROS_REJECTED");
    try {
      inspectAutoFilterDrawings(drawingGroups[0]!, filterSheets.filter(sheet => sheet.pairs.length > 0));
    } catch {
      reject("UPLOAD_MACROS_REJECTED");
    }
  }
}
