// Fictional MS-XLS/MS-ODRAW structural vectors. No customer bytes or cell data.
function words16(values: number[]) {
  const bytes = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => bytes.writeUInt16LE(value, index * 2));
  return bytes;
}
function words32(values: number[]) {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => bytes.writeUInt32LE(value, index * 4));
  return bytes;
}
function art(type: number, version: number, instance: number, body: Buffer) {
  const header = Buffer.alloc(8);
  header.writeUInt16LE(version | (instance << 4));
  header.writeUInt16LE(type, 2);
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}
function opt(properties: [number, number][]) {
  return art(0xf00b, 3, properties.length, Buffer.concat(properties.map(([id, value]) => {
    const bytes = Buffer.alloc(6);
    bytes.writeUInt16LE(id);
    bytes.writeUInt32LE(value, 2);
    return bytes;
  })));
}
function obj(id: number, filtered = false) {
  return Buffer.concat([
    words16([0x15, 18, 0x14, id, 0x2101]), Buffer.alloc(12),
    words16([0x0c, 20]), words32([0]), words16([0, 0, 100, 1, 10, 0, 16, 1]),
    words16([0x13, 0x1fee, 0, 0, 0, 0x301, 0, filtered ? 10 : 2, 8, 0, 0, 0]),
  ]);
}
export function makeAutoFilterProfile(columns: number | number[] = 3) {
  const columnCounts = typeof columns === "number" ? [columns] : columns;
  const sheets = columnCounts.map((count, sheetIndex) => {
    const drawingId = sheetIndex + 1;
    const shapeBase = 1024 * drawingId;
    const common = art(0xf004, 15, 0, Buffer.concat([
      art(0xf009, 1, 0, Buffer.alloc(16)), art(0xf00a, 2, 0, words32([shapeBase, 5])),
    ]));
    const shapes = Array.from({ length: count }, (_, col) => art(0xf004, 15, 0, Buffer.concat([
      art(0xf00a, 2, 201, words32([shapeBase + col + 1, 0xa00])),
      opt([[0x7f, 0x01040104], [0xbf, 0x00080008], [0x1ff, 0x00080000], [0x3bf, 0x00020000]]),
      art(0xf010, 0, 0, words16([1, col, 0, 0, 0, col, 1023, 0, 255])),
      art(0xf011, 0, 0, Buffer.alloc(0)),
    ])));
    const group = art(0xf003, 15, 0, Buffer.concat([common, ...shapes]));
    const drawing = art(0xf002, 15, 0, Buffer.concat([
      art(0xf008, 0, drawingId, words32([count + 1, shapeBase + count])), group,
    ]));
    const prefixLength = drawing.length - shapes.reduce((sum, bytes) => sum + bytes.length, 0);
    const pairs = shapes.map((shape, index) => ({
      drawing: index ? shape : Buffer.concat([drawing.subarray(0, prefixLength), shape]),
      object: obj(index + 1, index === 1),
    }));
    return { filterColumns: count, pairs };
  });
  const total = columnCounts.reduce((sum, count) => sum + count + 1, 0);
  const clusters = columnCounts.flatMap((count, index) => [index + 1, count + 1]);
  const global = art(0xf000, 15, 0, Buffer.concat([
    art(0xf006, 0, 0, words32([1024 * (sheets.length + 1) + 1, sheets.length + 1, total, sheets.length, ...clusters])),
    opt([[0xbf, 0x00080008], [0x181, 0x08000041], [0x1c0, 0x08000040]]),
    art(0xf11e, 0, 4, words32([0, 0xffffff, 0xffffff, 0])),
  ]));
  return { global, sheets };
}
