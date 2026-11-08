/**
 * Narrow Excel BIFF8 AutoFilter-button profile; not generic OBJ support.
 * MS-XLS Obj/FtCmo/FtSbs/FtLbsData and MS-ODRAW drawing containers.
 * Refuse unrecognized structures rather than handing them to an Office parser.
 */
export type FilterSheet = { filterColumns: number; pairs: { drawing: Buffer; object: Buffer }[] };
type Art = { type: number; version: number; instance: number; body: Buffer };

function check(ok: unknown): asserts ok {
  if (!ok) throw new Error("unsupported-autofilter-profile");
}

function records(bytes: Buffer): Art[] {
  check(bytes.length <= 128 * 1024);
  const out: Art[] = [];
  for (let at = 0; at < bytes.length;) {
    check(at + 8 <= bytes.length && out.length < 300);
    const flags = bytes.readUInt16LE(at);
    const length = bytes.readUInt32LE(at + 4);
    check(at + 8 + length <= bytes.length);
    out.push({
      type: bytes.readUInt16LE(at + 2), version: flags & 15,
      instance: flags >>> 4, body: bytes.subarray(at + 8, at + 8 + length),
    });
    at += 8 + length;
  }
  return out;
}

function kind(art: Art | undefined, type: number, version: number, instance = 0): asserts art is Art {
  check(art?.type === type && art.version === version && art.instance === instance);
}

function properties(art: Art | undefined, expected: readonly (readonly [number, number | null])[]) {
  kind(art, 0xf00b, 3, expected.length);
  check(art.body.length === expected.length * 6);
  expected.forEach(([id, value], index) => {
    // Exact IDs also exclude fComplex/fBid, links, names and embedded resources.
    check(art.body.readUInt16LE(index * 6) === id);
    check(value === null || art.body.readUInt32LE(index * 6 + 2) === value);
  });
}

export function inspectAutoFilterObject(body: Buffer) {
  check(body.length === 70);
  const word = (at: number) => body.readUInt16LE(at);
  check(word(0) === 0x15 && word(2) === 18 && word(4) === 0x14 && word(6) > 0);
  check(word(8) === 0x2101 && body.subarray(10, 22).every(byte => byte === 0));
  check(word(22) === 0x0c && word(24) === 20);
  // This profile is Excel's simple filter button, not a user-defined control.
  check(body.subarray(26, 46).equals(Buffer.from("0000000000000000640001000a00000010000100", "hex")));
  check(word(46) === 0x13 && word(48) >= 20);
  check(word(50) === 0); // ObjFmla.cbFmla: no formula, macro or linked range.
  check(word(52) === 0 && word(54) <= 0x7fff); // dynamic AutoFilter list, cached selection
  check(word(56) === 0x0301 && word(58) === 0); // fUseCB, lct=AutoFilter; no edit/list strings
  check([2, 10].includes(word(60)) && word(62) <= 0x7fff && word(64) <= 0x7fff);
  check(body.subarray(66).every(byte => byte === 0)); // empty string and padding
  return word(6);
}

export function inspectAutoFilterDrawings(global: Buffer, sheets: FilterSheet[]) {
  check(sheets.length > 0 && sheets.length <= 100);
  const total = sheets.reduce((sum, sheet) => sum + sheet.pairs.length + 1, 0);
  check(global.length <= 16384);
  const globals = records(global);
  check(globals.length === 1);
  kind(globals[0], 0xf000, 15);
  const group = records(globals[0].body);
  check(group.length === 3);
  kind(group[0], 0xf006, 0);
  const dgg = group[0].body;
  check(dgg.length >= 24 && dgg.length % 8 === 0);
  const clusters = dgg.readUInt32LE(4);
  check(clusters >= 2 && clusters <= 101 && dgg.length === 16 + (clusters - 1) * 8);
  check(dgg.readUInt32LE(8) === total && dgg.readUInt32LE(12) === sheets.length);
  const declaredMaxShape = dgg.readUInt32LE(0);
  check(declaredMaxShape > 0 && declaredMaxShape <= 1024 * 1024);
  const clusterCounts = new Map<number, number>();
  for (let offset = 16; offset < dgg.length; offset += 8) {
    const drawingId = dgg.readUInt32LE(offset);
    const count = dgg.readUInt32LE(offset + 4);
    check(drawingId > 0 && drawingId <= 0x0fff && count > 0 && count <= 257 && !clusterCounts.has(drawingId));
    clusterCounts.set(drawingId, count);
  }
  check(clusterCounts.size === sheets.length);
  properties(group[1], [[0x00bf, 0x00080008], [0x0181, null], [0x01c0, null]]);
  kind(group[2], 0xf11e, 0, 4);
  check(group[2].body.length === 16);

  const shapeIds = new Set<number>();
  const drawingIds = new Set<number>();
  let maxShape = 0;
  for (const sheet of sheets) {
    check(sheet.filterColumns > 0 && sheet.filterColumns <= 256 && sheet.pairs.length === sheet.filterColumns);
    const objectIds = new Set<number>();
    for (const pair of sheet.pairs) {
      const id = inspectAutoFilterObject(pair.object);
      check(!objectIds.has(id));
      objectIds.add(id);
      check(pair.drawing.subarray(-8).equals(Buffer.from("000011f000000000", "hex")));
    }
    const art = records(Buffer.concat(sheet.pairs.map(pair => pair.drawing)));
    check(art.length === 1);
    kind(art[0], 0xf002, 15);
    const drawing = records(art[0].body);
    check(drawing.length === 2);
    check(drawing[0]?.type === 0xf008 && drawing[0].version === 0 && drawing[0].instance > 0 && drawing[0].body.length === 8);
    check(!drawingIds.has(drawing[0].instance));
    drawingIds.add(drawing[0].instance);
    check(drawing[0].body.readUInt32LE(0) === sheet.pairs.length + 1);
    check(clusterCounts.get(drawing[0].instance) === sheet.pairs.length + 1);
    kind(drawing[1], 0xf003, 15);
    const shapes = records(drawing[1].body);
    check(shapes.length === sheet.pairs.length + 1);
    for (let index = 0; index < shapes.length; index++) {
      kind(shapes[index], 0xf004, 15);
      const atoms = records(shapes[index]!.body);
      const isGroup = index === 0;
      check(atoms.length === (isGroup ? 2 : 4));
      if (isGroup) {
        kind(atoms[0], 0xf009, 1);
        check(atoms[0].body.length === 16 && atoms[0].body.every(byte => byte === 0));
      }
      const shape = atoms[isGroup ? 1 : 0];
      kind(shape, 0xf00a, 2, isGroup ? 0 : 201);
      check(shape.body.length === 8);
      const id = shape.body.readUInt32LE(0);
      check(id > 0 && id < declaredMaxShape && !shapeIds.has(id));
      shapeIds.add(id);
      maxShape = Math.max(maxShape, id);
      check(shape.body.readUInt32LE(4) === (isGroup ? 5 : 0x0a00)); // no OLE/connector/deleted shape
      if (!isGroup) {
        properties(atoms[1], [[0x007f, 0x01040104], [0x00bf, 0x00080008], [0x01ff, 0x00080000], [0x03bf, 0x00020000]]);
        kind(atoms[2], 0xf010, 0);
        check(atoms[2].body.length === 18);
        check([0, 1, 2, 3].includes(atoms[2].body.readUInt16LE(0)));
        check(atoms[2].body.readUInt16LE(2) < 256 && atoms[2].body.readUInt16LE(10) < 256);
        kind(atoms[3], 0xf011, 0);
        check(atoms[3].body.length === 0);
      }
    }
  }
  check(declaredMaxShape > maxShape);
  return { classifiedFilterButtons: total - sheets.length, sheets: sheets.length };
}
