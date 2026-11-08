import { crc32, inflateRawSync } from 'node:zlib';
import { SaxesParser } from 'saxes';
import path from 'node:path';

const SS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const ALLOWED = /^(?:\[Content_Types\]\.xml|_rels\/\.rels|docProps\/(?:core|app)\.xml|xl\/(?:workbook\.xml|_rels\/workbook\.xml\.rels|styles\.xml|sharedStrings\.xml|calcChain\.xml|theme\/theme1\.xml|worksheets\/sheet[1-4]\.xml|worksheets\/_rels\/sheet[1-4]\.xml\.rels|tables\/table[1-3]\.xml))$/;
function check(ok, message = 'Excel no admès: cal conservar la plantilla d’una sola botiga.') {
  if (!ok) throw Object.assign(new Error(message), { status: 400 });
}

// Decode every ZIP member with real output and CRC limits; never trust claimed sizes.
export function workbookParts(data) {
  check(Buffer.isBuffer(data) && data.length >= 22 && data.length <= 10 * 1024 * 1024);
  let end = data.length - 22;
  while (end >= Math.max(0, data.length - 65557) && data.readUInt32LE(end) !== 0x06054b50) end--;
  check(end >= 0 && data.readUInt32LE(end) === 0x06054b50);
  const count = data.readUInt16LE(end + 10), central = data.readUInt32LE(end + 16);
  check(data.readUInt32LE(end + 4) === 0 && data.readUInt16LE(end + 8) === count && count <= 128 &&
    end + 22 + data.readUInt16LE(end + 20) === data.length && central + data.readUInt32LE(end + 12) === end);
  let at = central, total = 0;
  const files = new Map(), ranges = [], names = new Set();
  for (let i = 0; i < count; i++) {
    check(at + 46 <= end && data.readUInt32LE(at) === 0x02014b50);
    const flags = data.readUInt16LE(at + 8), codec = data.readUInt16LE(at + 10);
    const size = data.readUInt32LE(at + 24), compressed = data.readUInt32LE(at + 20), crc = data.readUInt32LE(at + 16);
    const nameLength = data.readUInt16LE(at + 28), local = data.readUInt32LE(at + 42);
    const next = at + 46 + nameLength + data.readUInt16LE(at + 30) + data.readUInt16LE(at + 32);
    check(next <= end && (flags & ~0x080e) === 0 && [0, 8].includes(codec) && data.readUInt16LE(at + 34) === 0);
    const nameBytes = data.subarray(at + 46, at + 46 + nameLength), name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
    check(!names.has(name) && !name.includes('..') && !name.includes('\\') && !name.startsWith('/')); names.add(name);
    const folder = name.endsWith('/');
    check(folder ? size === 0 : ALLOWED.test(name), `L’Excel conté un recurs no admès: ${name}. No s’ha modificat ni enviat.`);
    check(size <= 8 * 1024 * 1024 && (total += size) <= 32 * 1024 * 1024);
    check(local + 30 <= central && data.readUInt32LE(local) === 0x04034b50 && data.readUInt16LE(local + 6) === flags && data.readUInt16LE(local + 8) === codec);
    check(data.readUInt16LE(local + 26) === nameLength && data.subarray(local + 30, local + 30 + nameLength).equals(nameBytes));
    const start = local + 30 + nameLength + data.readUInt16LE(local + 28), finish = start + compressed;
    check(finish <= central);
    let rangeEnd = finish;
    if (flags & 8) {
      const descriptor = finish + (finish + 4 <= central && data.readUInt32LE(finish) === 0x08074b50 ? 4 : 0);
      check(descriptor + 12 <= central && data.readUInt32LE(descriptor) === crc && data.readUInt32LE(descriptor + 4) === compressed && data.readUInt32LE(descriptor + 8) === size);
      rangeEnd = descriptor + 12;
    } else check(data.readUInt32LE(local + 14) === crc && data.readUInt32LE(local + 18) === compressed && data.readUInt32LE(local + 22) === size);
    check(!ranges.some(([a, b]) => local < b && rangeEnd > a)); ranges.push([local, rangeEnd]);
    const bytes = codec === 8 ? inflateRawSync(data.subarray(start, finish), { maxOutputLength: 8 * 1024 * 1024 }) : data.subarray(start, finish);
    check(bytes.length === size && crc32(bytes) === crc);
    if (!folder) files.set(name, new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    at = next;
  }
  ranges.sort(([a], [b]) => a - b);
  check(at === end && ranges[0]?.[0] === 0 && ranges.at(-1)?.[1] === central && ranges.every(([a], i) => !i || a === ranges[i - 1][1]));
  return files;
}

function parse(xml) {
  check(typeof xml === 'string');
  const parser = new SaxesParser({ xmlns: true }), stack = [];
  let root, count = 0;
  parser.on('doctype', () => check(false));
  parser.on('processinginstruction', () => check(false));
  parser.on('opentag', tag => {
    check(++count <= 200000 && stack.length < 64);
    const attrs = {};
    for (const a of Object.values(tag.attributes)) if (a.uri !== 'http://www.w3.org/2000/xmlns/') { check(!Object.hasOwn(attrs, a.local)); attrs[a.local] = a.value; }
    check(!['oleObjects', 'externalReferences', 'hyperlinks', 'drawing', 'legacyDrawing', 'controls', 'webPublishItems'].includes(tag.local));
    if (tag.uri === REL && tag.local === 'Relationship') check(attrs.TargetMode !== 'External' && !/^[a-z]+:|^\/\/|\\/i.test(attrs.Target || ''));
    const node = { name: tag.local, uri: tag.uri, attrs, children: [], text: '' };
    if (stack.length) stack.at(-1).children.push(node); else root = node;
    stack.push(node);
  });
  parser.on('text', text => { if (stack.length) stack.at(-1).text += text; });
  parser.on('cdata', text => { if (stack.length) stack.at(-1).text += text; });
  parser.on('closetag', () => { const node = stack.pop(); if (node.children.length && !node.text.trim()) node.text = ''; });
  parser.write(xml).close();
  check(root); return root;
}
const child = (node, name) => node?.children.find(c => c.name === name);
const descendants = (node, name) => (node?.children || []).flatMap(c => [...(c.name === name ? [c] : []), ...descendants(c, name)]);
const text = node => node ? node.text + node.children.map(text).join('') : '';
const stable = node => JSON.stringify(node, (key, value) => key === 'attrs' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);

export function inspectWorkbook(bytes) {
  const parts = workbookParts(bytes), trees = new Map([...parts].map(([name, xml]) => [name, parse(xml)]));
  for (const [name, tree] of trees) if (name.endsWith('.rels')) {
    const parent = name === '_rels/.rels' ? '' : path.posix.dirname(name).replace(/(?:^|\/)_rels$/, '');
    for (const relationship of descendants(tree, 'Relationship')) {
      const raw = relationship.attrs.Target || '';
      const target = path.posix.normalize(raw.startsWith('/') ? raw.slice(1) : path.posix.join(parent, raw));
      check(parts.has(target) && ALLOWED.test(target), 'L’Excel conté una relació externa o desconeguda.');
    }
  }
  const workbook = trees.get('xl/workbook.xml'); check(workbook?.uri === SS);
  const sheets = descendants(workbook, 'sheet');
  check(sheets.length === 4 && sheets.filter(s => !s.attrs.state || s.attrs.state === 'visible').length === 1 &&
    sheets.slice(1).every(s => ['hidden', 'veryHidden'].includes(s.attrs.state)) &&
    sheets.slice(1).map(s => s.attrs.name).join('|') === 'TRACTES|VACANCES|PESONAL');
  const relationships = descendants(trees.get('xl/_rels/workbook.xml.rels'), 'Relationship');
  const strings = descendants(trees.get('xl/sharedStrings.xml'), 'si').map(text), usedStrings = new Set();
  const grid = sheets.map((sheet, index) => {
    const relationship = relationships.find(r => r.attrs.Id === sheet.attrs.id);
    const target = relationship?.attrs.Target;
    check(target === `worksheets/sheet${index + 1}.xml` || target === `/xl/worksheets/sheet${index + 1}.xml`);
    const tree = trees.get(`xl/worksheets/sheet${index + 1}.xml`); check(tree?.uri === SS && tree.name === 'worksheet');
    const cells = new Map(), styles = new Map();
    for (const cell of descendants(child(tree, 'sheetData'), 'c')) {
      check(cell.uri === SS && Object.keys(cell.attrs).every(k => ['r', 's', 't'].includes(k)) && cell.children.every(c => c.uri === SS && ['f', 'v', 'is'].includes(c.name)));
      const address = cell.attrs.r; check(/^[A-Z]{1,3}[1-9]\d{0,5}$/.test(address) && !cells.has(address));
      check(!styles.has(address)); styles.set(address, cell.attrs.s || '0');
      const formula = child(cell, 'f');
      let value = text(child(cell, 'v'));
      if (cell.attrs.t === 's') { const key = Number(value); check(Number.isSafeInteger(key) && key >= 0 && key < strings.length); usedStrings.add(key); value = strings[key]; }
      else if (cell.attrs.t === 'inlineStr') value = text(child(cell, 'is'));
      else if (!cell.attrs.t || cell.attrs.t === 'n') { if (value !== '') { check(Number.isFinite(Number(value))); value = String(Number(value)); } }
      if (formula) value = ''; // Formula caches may be recalculated by Excel.
      if (value !== '' || formula) cells.set(address, { value, ...(formula ? { formula: { text: text(formula), type: formula.attrs.t || '', si: formula.attrs.si || '', ref: formula.attrs.ref || '' } } : {}) });
    }
    return { name: sheet.attrs.name, cells, styles, tree };
  });
  check(strings.every((value, i) => !value || usedStrings.has(i)), 'L’Excel conserva textos ocults sense ús. Cal un fitxer d’una sola botiga.');
  return { grid, trees };
}

export function compareReviewedWorkbook(sourceBytes, returnedBytes) {
  const source = inspectWorkbook(sourceBytes), returned = inspectWorkbook(returnedBytes), changes = [];
  const fixedWorkbook = book => {
    const properties = child(book, 'workbookPr');
    check(!properties?.attrs.date1904 || ['0', 'false'].includes(properties.attrs.date1904), 'S’ha canviat el calendari base del llibre.');
    const result = structuredClone(book);
    result.children = result.children.filter(n => !['bookViews', 'calcPr', 'fileVersion', 'workbookPr'].includes(n.name));
    for (const sheet of descendants(result, 'sheet')) if (sheet.attrs.state === 'visible') delete sheet.attrs.state;
    for (const name of descendants(result, 'definedName')) name.text = name.text.replace(/'([A-Za-z_][A-Za-z_0-9]*)'!/g, '$1!');
    return result;
  };
  check(stable(fixedWorkbook(source.trees.get('xl/workbook.xml'))) === stable(fixedWorkbook(returned.trees.get('xl/workbook.xml'))), 'S’ha canviat l’estructura o els noms definits del llibre.');
  // Formatting resources can carry formulas/foreign data too; keep their semantic trees.
  for (const [name, tree] of returned.trees) {
    if (/^(?:xl\/(?:styles|theme\/theme1|tables\/table[1-3])\.xml)$/.test(name)) check(source.trees.has(name) && stable(tree) === stable(source.trees.get(name)), 'S’han canviat estils o taules auxiliars. Revisa una còpia de l’Excel original sense canviar-ne la plantilla.');
  }
  for (const [index, sheet] of returned.grid.entries()) {
    const original = source.grid[index]; check(sheet.name === original.name, 'Els noms dels fulls han canviat.');
    const rowLayout = tree => descendants(child(tree, 'sheetData'), 'row').map(row => {
      const attrs = { ...row.attrs }; delete attrs.spans; // Excel may recompute occupied-column hints.
      return { attrs };
    });
    check(stable(rowLayout(sheet.tree)) === stable(rowLayout(original.tree)), 'S’han canviat les files, alçades o visibilitat del full.');
    for (const address of new Set([...original.styles.keys(), ...sheet.styles.keys()])) {
      check((original.styles.get(address) || '0') === (sheet.styles.get(address) || '0'), `S’ha canviat el format de ${sheet.name}!${address}.`);
    }
    const fixedSheet = tree => ({ ...tree, children: tree.children.filter(n => !['sheetData', 'sheetViews', 'dimension'].includes(n.name)) });
    check(stable(fixedSheet(sheet.tree)) === stable(fixedSheet(original.tree)), 'S’ha canviat l’estructura, les fórmules de format o la impressió del full.');
    const addresses = new Set([...original.cells.keys(), ...sheet.cells.keys()]);
    for (const address of addresses) {
      const before = original.cells.get(address) || { value: '' }, after = sheet.cells.get(address) || { value: '' };
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      const [, column, rowText] = address.match(/^([A-Z]+)(\d+)$/), row = Number(rowText), personRow = row % 2 ? row - 1 : row;
      const person = original.cells.get(`B${personRow}`)?.value;
      const code = /^[EGIKMOQ]$/.test(column) && row === personRow;
      const hours = /^[FHJLNPR]$/.test(column);
      check(index === 0 && row >= 6 && row <= 91 && person && (code || hours) && !before.formula && !after.formula,
        `S’ha canviat ${sheet.name}!${address} fora dels torns editables. No s’ha modificat ni enviat el fitxer.`);
      check(code ? /^(?:M|T|D|F|V|B)?$/.test(after.value) : /^(?:SI|(?:[01]?\d|2[0-3]):[0-5]\d\s*[–-]\s*(?:[01]?\d|2[0-3]):[0-5]\d)?$/.test(after.value), `Valor de torn o hores no admès a ${address}.`);
      changes.push({ cell: address, person, before: before.value, after: after.value });
    }
  }
  return { changes, title: source.grid[0].cells.get('G4')?.value, year: source.grid[0].cells.get('O4')?.value, week: source.grid[0].cells.get('D4')?.value };
}
