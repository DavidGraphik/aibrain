import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { MODEL_ORDER, DEFERRED_FIELDS, schemaModels, decodeBytes, reviveDates, stripDeferred, tableName } from '../utils/backupModels.js';

export function validateBackup(bytes) {
  const backup = JSON.parse(bytes.toString());
  const data = backup.datos;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid backup');
  if (Object.keys(data).some(name => !MODEL_ORDER.includes(name))) throw new Error('Unknown backup models');
  if (MODEL_ORDER.some(name => !Object.hasOwn(data, name))) throw new Error('Backup is incomplete; a model is missing');
  const counts = {};
  for (const name of MODEL_ORDER) {
    const rows = data[name] ?? [];
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('Invalid model rows');
    if (backup.recuentos?.[name] !== undefined && backup.recuentos[name] !== rows.length) throw new Error('Backup count mismatch');
    counts[name] = rows.length;
  }
  return { data, report: { sourceDate: backup.generadoEl, sha256: createHash('sha256').update(bytes).digest('hex'), counts, absentModels: MODEL_ORDER.filter(name => !(name in data)) } };
}
export async function importEmptyDatabase(client, data) {
  return client.$transaction(async tx => {
    const delegate = name => tx[name[0].toLowerCase() + name.slice(1)];
    for (const name of MODEL_ORDER) if (await delegate(name).count()) throw new Error('Destination is not empty; refusing to overwrite customer data');
    for (const name of MODEL_ORDER) {
      const rows = stripDeferred(name, decodeBytes(name, reviveDates(name, data[name] || [])));
      for (let i = 0; i < rows.length; i += 250) await delegate(name).createMany({ data: rows.slice(i, i + 250) });
    }
    for (const [name, fields] of Object.entries(DEFERRED_FIELDS)) for (const row of data[name] || []) {
      const deferred = Object.fromEntries(fields.filter(f => row[f] !== null && row[f] !== undefined).map(f => [f, row[f]]));
      if (Object.keys(deferred).length) await delegate(name).update({ where: { id: row.id }, data: deferred });
    }
    for (const model of schemaModels()) {
      const id = model.fields.find(f => f.isId && f.type === 'Int' && f.default?.name === 'autoincrement');
      if (!id) continue;
      const table = tableName(model.name);
      // Identifiers come exclusively from Prisma's compiled schema, never the backup.
      await tx.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('"${table}"', '${id.name}'), COALESCE((SELECT MAX("${id.name}") FROM "${table}"), 0) + 1, false)`);
    }
    const counts = {};
    for (const name of MODEL_ORDER) counts[name] = await delegate(name).count();
    return counts;
  }, { timeout: 120_000, isolationLevel: 'Serializable' });
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [file, flag, expectedHash] = process.argv.slice(2);
  const { data, report } = validateBackup(await readFile(file));
  console.log(JSON.stringify(report));
  if (flag === '--apply-empty' && expectedHash === report.sha256) {
    if (!process.env.HORARIA_INSTALLATION_ID) throw new Error('An explicit installation binding is required');
    const client = new PrismaClient();
    try { console.log(JSON.stringify({ imported: await importEmptyDatabase(client, data) })); } finally { await client.$disconnect(); }
  } else if (flag) throw new Error('Use --apply-empty with the inspected SHA256 to import into an empty database');
}
