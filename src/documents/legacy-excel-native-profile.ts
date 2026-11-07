import { inspectLegacyExcel, readPassiveLegacyExcelContainer } from "./legacy-excel-validation";
import { inspectLegacyTheme } from "./legacy-excel-theme";

function check(ok: unknown): asserts ok { if (!ok) throw new Error("unsupported-native-xls-profile"); }

// MS-XLS 2.3.2. Closed record catalog, not a denylist of known dangerous features.
// Unlisted records (including names/functions/queries/pivots/conditional formulas,
// XLM/VBA, hyperlinks, external caches and future extensions) select passive reading.
const INERT = new Set([
  0x000a, // EOF
  0x000c, 0x000d, 0x000e, 0x000f, 0x0010, 0x0011, // calculation options
  0x0012, 0x0013, 0x0014, 0x0015, 0x0019, 0x001a, 0x001b, 0x001d, // protection, print, selection
  0x0022, 0x0026, 0x0027, 0x0028, 0x0029, 0x002a, 0x002b,
  0x0031, 0x003d, 0x0040, 0x0041, 0x0042, 0x0055, 0x005c, 0x005f, 0x0063,
  0x007d, 0x0080, 0x0081, 0x0082, 0x0083, 0x0084, 0x008c, 0x008d, 0x0092,
  0x009b, 0x009c, 0x009d, 0x009e, 0x00a0, 0x00a1, // inert AutoFilter comparisons
  0x00bd, 0x00be, 0x00c1, 0x00d7, 0x00da, 0x00dd, 0x00e0, 0x00e1, 0x00e2, 0x00e5,
  0x00fc, 0x00fd, 0x00ff, 0x013d, 0x0160, 0x0161, 0x01af, 0x01b7, 0x01bc, 0x01c0, 0x01c1,
  0x0200, 0x0201, 0x0203, 0x0204, 0x0205, 0x0207, 0x0208, 0x020b, 0x0225, 0x023e, 0x027e, 0x0293, 0x041e,
  0x0863, 0x087c, 0x087d, 0x088b, 0x088c, 0x088e, 0x0892, 0x089a, 0x089b, 0x089c, 0x08a3,
]);
const SPECIAL = new Set([0x0006, 0x0017, 0x0018, 0x003c, 0x005d, 0x0085, 0x00eb, 0x00ec, 0x01ae, 0x0809, 0x0866, 0x0867, 0x087e, 0x087f, 0x0896]);

/** Full RPN walk of a deliberately small local formula grammar, never execution.
 * MS-XLS Ptg/Rgce: arithmetic, scalar constants, local cells/ranges and SUM only.
 * No names, 3D references, shared/array formulas, add-ins, commands or dynamic functions.
 */
export function inspectLocalFormula(tokens: Buffer) {
  check(tokens.length > 0 && tokens.length <= 4096);
  let stack = 0;
  for (let at = 0; at < tokens.length;) {
    const raw = tokens[at]!;
    check(raw < 0x80);
    const id = raw >= 0x20 ? (raw & 0x1f) | 0x20 : raw;
    let size = 1;
    if (id >= 3 && id <= 0x11) { check(stack >= 2); stack--; }
    else if (id >= 0x12 && id <= 0x15) check(stack >= 1);
    else if (id === 0x1c || id === 0x1d) { size = 2; stack++; }
    else if (id === 0x1e) { size = 3; stack++; }
    else if (id === 0x1f) { size = 9; stack++; }
    else if (id === 0x24) { size = 5; stack++; }
    else if (id === 0x25) { size = 9; stack++; }
    else if (id === 0x22) {
      size = 4; check(at + size <= tokens.length);
      const args = tokens[at + 1]!;
      // SUM Ftab=4, fCeFunc=0. All other functions and high-bit commands fail closed.
      check(args >= 1 && args <= 30 && stack >= args && tokens.readUInt16LE(at + 2) === 4);
      stack += 1 - args;
    } else if (id === 0x19) {
      size = 4; check(at + size <= tokens.length && stack >= 1);
      check(tokens[at + 1] === 0x10 && tokens.readUInt16LE(at + 2) === 0); // PtgAttrSum
    } else check(false);
    check(at + size <= tokens.length && stack <= 64);
    if (id === 0x1d) check(tokens[at + 1]! <= 1);
    if (id === 0x1f) check(Number.isFinite(tokens.readDoubleLE(at + 1)));
    if (id === 0x24) check((tokens.readUInt16LE(at + 3) & 0x3fff) < 256);
    if (id === 0x25) check((tokens.readUInt16LE(at + 5) & 0x3fff) < 256 && (tokens.readUInt16LE(at + 7) & 0x3fff) < 256);
    at += size;
  }
  check(stack === 1);
}

type Record = { id: number; body: Buffer; offset: number; kind: number };
function frt(body: Buffer, id: number, reference = false) {
  check(body.length >= 12 && body.readUInt16LE(0) === id && body.readUInt16LE(2) === (reference ? 1 : 0));
  if (!reference) check(body.subarray(4, 12).every(byte => byte === 0));
  else check(body.readUInt16LE(4) <= body.readUInt16LE(6) && body.readUInt16LE(8) <= body.readUInt16LE(10) && body.readUInt16LE(10) < 256);
}

// No picture, BLIP, properties, link or executable object: only an empty HF group.
function emptyHeaderPicture(b: Buffer) {
  frt(b, 0x866);
  check(b.length === 78 && b[12] === 2 && b[13] === 0);
  check(b.readUInt16LE(14) === 15 && b.readUInt16LE(16) === 0xf000 && b.readUInt32LE(18) === 56);
  check(b.readUInt32LE(22) === 0xf0060000 && b.readUInt32LE(26) === 24);
  check(b.readUInt32LE(30) > 0 && b.readUInt32LE(34) === 2 && b.readUInt32LE(38) === 1 && b.readUInt32LE(42) === 0);
  check(b.readUInt32LE(46) > 0 && b.readUInt32LE(50) === 1);
  check(b.readUInt32LE(54) === 0xf11e0040 && b.readUInt32LE(58) === 16); // colour palette only
}

function filterContinuation(body: Buffer, criteria: boolean) {
  frt(body, 0x87f, true);
  const b = body.subarray(12);
  if (!criteria) {
    check(b.length === 24 && b.readUInt16LE(2) >= 1 && b.readUInt16LE(2) <= 12 &&
      b.readUInt32LE(4) >= 1 && b.readUInt32LE(4) <= 31 && b.readUInt16LE(8) <= 23 &&
      b.readUInt16LE(10) <= 59 && b.readUInt16LE(12) <= 59 && b.readUInt32LE(16) === 0 && b.readUInt32LE(20) <= 5);
  } else {
    check(b.length >= 10 && [4, 6, 8, 12, 14].includes(b[0]!) && b[1]! >= 1 && b[1]! <= 6);
    if (b[0] === 6) {
      check(b.length >= 11 && (b[10] === 0 || b[10] === 1));
      check(b[2]! > 0 && b[3]! <= 1 && b[4] === 0 && b.length === 11 + b[2]! * (b[10] ? 2 : 1));
    } else check(b.length === 10);
  }
}

/** Selects a documented closed subset; false means use the isolated passive path.
 * This is additional to the strict CFB/AutoFilter admission, never a replacement.
 */
export function supportsNativeLegacyExcel(data: Buffer): boolean {
  try {
    inspectLegacyExcel(data);
    inspectNativeWorkbook(readPassiveLegacyExcelContainer(data).workbook);
    return true;
  } catch { return false; }
}

export function inspectNativeWorkbook(workbook: Buffer) {
  const records: Record[] = [], sheetTargets: number[] = [], sheetOffsets = new Set<number>();
  let kind = 0, globals = 0;
  for (let offset = 0; offset < workbook.length;) {
    if (kind === 0 && offset > 0 && workbook.subarray(offset).every(byte => byte === 0)) break;
    check(offset + 4 <= workbook.length);
    const id = workbook.readUInt16LE(offset), size = workbook.readUInt16LE(offset + 2);
    check(size <= 8224 && offset + 4 + size <= workbook.length && (INERT.has(id) || SPECIAL.has(id)));
    const body = workbook.subarray(offset + 4, offset + 4 + size);
    if (id === 0x809) {
      check(kind === 0 && size >= 8 && body.readUInt16LE(0) === 0x600);
      kind = body.readUInt16LE(2); check(kind === 5 || kind === 0x10);
      if (kind === 5) check(offset === 0 && ++globals === 1);
      else sheetOffsets.add(offset);
    } else check(kind !== 0);
    records.push({ id, body, offset, kind });
    if (id === 0xa) { check(size === 0); kind = 0; }
    if (id === 0x85) {
      check(kind === 5 && size >= 8 && body[5] === 0 && sheetTargets.length < 100);
      sheetTargets.push(body.readUInt32LE(0));
    }
    offset += 4 + size;
  }
  check(kind === 0 && globals === 1 && sheetTargets.length > 0 && sheetOffsets.size === sheetTargets.length &&
    new Set(sheetTargets).size === sheetTargets.length && sheetTargets.every(target => sheetOffsets.has(target)));
  const supbooks = records.filter(record => record.id === 0x1ae);
  for (const record of supbooks) check(record.kind === 5 && record.body.length === 4 && record.body.readUInt16LE(2) === 0x401);
  const externalTables = records.filter(record => record.id === 0x17);
  check(externalTables.length <= 1 && supbooks.length <= 1);
  const xtis: [number, number][] = [];
  for (const { body: b, kind } of externalTables) {
    check(kind === 5 && b.length >= 2 && b.length === 2 + 6 * b.readUInt16LE(0));
    for (let at = 2; at < b.length; at += 6) {
      const first = b.readUInt16LE(at + 2), last = b.readUInt16LE(at + 4);
      check(b.readUInt16LE(at) < supbooks.length && first <= last && last < sheetTargets.length);
      xtis.push([first, last]);
    }
  }
  let continued = 0, criteria = 0, dates = 0, filterRef: Buffer | undefined;
  const hasObjects = records.some(record => record.id === 0x5d);
  for (const { id, body: b, kind } of records) {
    if (id !== 0x87f) check(criteria === 0 && dates === 0);
    if (id === 0x3c) check(continued === 0xfc || continued === 0x207);
    else continued = id;
    if ([0xeb, 0xec].includes(id)) check(hasObjects); // strict admission binds all OfficeArt/OBJ pairs
    if (id === 6) {
      check(kind === 0x10 && b.length >= 22 && b.readUInt16LE(2) < 256 && (b.readUInt16LE(14) & 8) === 0);
      check(b.readUInt16LE(20) === b.length - 22);
      inspectLocalFormula(b.subarray(22));
    }
    if (id === 0x18) {
      // Only the local built-in _FilterDatabase name, with one internal Area3d.
      check(kind === 5 && b.length === 27 && b.readUInt16LE(0) === 0x21 && b[2] === 0 && b[3] === 1 && b.readUInt16LE(4) === 11);
      check(b.readUInt16LE(6) === 0 && b.readUInt16LE(8) > 0 && b.readUInt16LE(8) <= sheetTargets.length && b.subarray(10, 14).every(byte => byte === 0));
      check(b[14] === 0 && b[15] === 0x0d && b[16] === 0x3b);
      const ref = xtis[b.readUInt16LE(17)];
      check(ref && ref[0] === b.readUInt16LE(8) - 1 && ref[1] === ref[0]);
      check(b.readUInt16LE(19) <= b.readUInt16LE(21) && b.readUInt16LE(23) <= b.readUInt16LE(25) && b.readUInt16LE(25) < 256);
    }
    if (id === 0x866) emptyHeaderPicture(b);
    if (id === 0x867) {
      frt(b, id); // ISFPROTECTION flags only. Smart-tag property bags remain passive.
      check(b.length === 23 && b.readUInt16LE(12) === 2 && b[14] === 1 && b.readUInt32LE(15) === 0xffffffff && b.readUInt32LE(19) <= 0x7fff);
    }
    if (id === 0x87e) {
      frt(b, id, true);
      check(kind === 0x10 && b.length === 60 && b.readUInt16LE(12) <= 255 && b.readUInt32LE(14) <= 1 && b.readUInt32LE(18) === 0 && b.readUInt32LE(22) === 0);
      criteria = b.readUInt32LE(26); dates = b.readUInt32LE(30);
      // The other bits are reserved/unused and MUST be ignored in MS-XLS 2.4.7.
      check(criteria + dates > 0 && criteria + dates <= 10000 && (b.readUInt16LE(34) & 8) !== 0 && b.readUInt32LE(40) === 0xffffffff && b.subarray(44).every(byte => byte === 0));
      filterRef = b.subarray(4, 12);
    }
    if (id === 0x87f) {
      check(criteria > 0 || dates > 0); check(filterRef?.equals(b.subarray(4, 12)));
      filterContinuation(b, criteria > 0);
      if (criteria) criteria--; else dates--;
    }
    if (id === 0x896) { frt(b, id); check(kind === 5 && b.length >= 16); inspectLegacyTheme(b.subarray(16)); }
    if (id >= 0x860 && INERT.has(id)) frt(b, id);
    if (id === 0x160) check(b.length === 2 && b.readUInt16LE(0) <= 1); // ELF tokens themselves are excluded by the formula grammar
    if (id === 0x161) check(b.length === 2 && b.readUInt16LE(0) === 0); // no alternate BIFF stream
  }
  check(criteria === 0 && dates === 0);
}
