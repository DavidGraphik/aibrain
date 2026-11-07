import { Prisma } from '@prisma/client';

// ─────────────────────────────────────────────
// WHAT A BACKUP HAS TO KNOW ABOUT THE SCHEMA
//
// A backup that silently misses a table is worse than no backup: it restores
// cleanly and you only discover the hole months later. So the *dump* asks
// Prisma which models exist rather than trusting a list, and the *restore*
// refuses to run against a file whose models it does not recognise. The list
// below therefore only carries what Prisma cannot tell us: the order rows must
// be written in.
// ─────────────────────────────────────────────

// A row can only be written once everything it points at exists. Establishment
// and Employee point at each other (Establishment.managerLocalId ↔
// Employee.establecimientoId), so that single link is written in a second pass
// — see DEFERRED_FIELDS.
export const MODEL_ORDER = [
  'Establishment',
  'Employee',
  'EmployeeEstablishment',
  'EstablishmentRules',
  'FreeTextRule',
  'ShiftPreference',
  'Absence',
  'Schedule',
  'ScheduleEdit',
  'CorreccionMotivo',
  'Ajuste',
  'SemanaIntensidad',
  'HorarioInforme',
  'WhatsappConversation',
  'WhatsappMessage',
  'PaperSheet',
  // No depèn de res ni res no en depèn: va al final perquè l'ordre només
  // importa per les claus foranes, i aquesta taula no en té cap.
  'ClientError',
];

// Fields written only after every table is in place, because they close a
// reference cycle. They are nullable by definition: a cycle through a required
// field could not be restored at all.
export const DEFERRED_FIELDS = { Establishment: ['managerLocalId'] };

export function schemaModels() {
  return Prisma.dmmf.datamodel.models;
}

export function schemaModelNames() {
  return schemaModels().map((m) => m.name);
}

/** Table name behind a model (`@@map`), needed to reset id sequences. */
export function tableName(modelName) {
  const model = schemaModels().find((m) => m.name === modelName);
  return model?.dbName || modelName;
}

/** DateTime columns — JSON gives them back as strings and Prisma wants Dates. */
export function dateFields(modelName) {
  const model = schemaModels().find((m) => m.name === modelName);
  if (!model) return [];
  return model.fields.filter((f) => f.type === 'DateTime' && !f.relationName).map((f) => f.name);
}

/**
 * Models this one holds a foreign key to, ignoring deferred fields. Only the
 * side that stores the key is reported, which is exactly the side that has to
 * be written second.
 */
export function dependenciesOf(modelName) {
  const model = schemaModels().find((m) => m.name === modelName);
  if (!model) return [];
  const deferred = DEFERRED_FIELDS[modelName] || [];
  const deps = new Set();
  for (const field of model.fields) {
    if (!field.relationFromFields?.length) continue;
    if (field.relationFromFields.every((f) => deferred.includes(f))) continue;
    if (field.type !== modelName) deps.add(field.type); // self-references sort themselves out
  }
  return [...deps];
}

/** Binary columns — JSON.stringify turns a Buffer into a byte-array object. */
export function bytesFields(modelName) {
  const model = schemaModels().find((m) => m.name === modelName);
  if (!model) return [];
  return model.fields.filter((f) => f.type === 'Bytes' && !f.relationName).map((f) => f.name);
}

/**
 * Binary columns as base64 for the dump. Left as a byte-array object, a
 * photographed sheet would come back from a restore as something Prisma cannot
 * write, and five times its own size on the way there.
 */
export function encodeBytes(modelName, rows) {
  const fields = bytesFields(modelName);
  if (fields.length === 0) return rows;
  return rows.map((row) => {
    const out = { ...row };
    for (const f of fields) {
      if (out[f] != null) out[f] = Buffer.from(out[f]).toString('base64');
    }
    return out;
  });
}

/** The other half: base64 back to a Buffer before writing it. */
export function decodeBytes(modelName, rows) {
  const fields = bytesFields(modelName);
  if (fields.length === 0) return rows;
  return rows.map((row) => {
    const out = { ...row };
    for (const f of fields) {
      if (typeof out[f] === 'string') out[f] = Buffer.from(out[f], 'base64');
    }
    return out;
  });
}

/**
 * JSON has no date type, so a dump gives dates back as strings and Prisma
 * rejects them. Rebuilds them in place, leaving nulls alone.
 */
export function reviveDates(modelName, rows) {
  const fields = dateFields(modelName);
  if (fields.length === 0) return rows;
  return rows.map((row) => {
    const out = { ...row };
    for (const f of fields) {
      if (typeof out[f] === 'string') out[f] = new Date(out[f]);
    }
    return out;
  });
}

/** Blanks the fields that close a reference cycle, for the first insert pass. */
export function stripDeferred(modelName, rows) {
  const deferred = DEFERRED_FIELDS[modelName] || [];
  if (deferred.length === 0) return rows;
  return rows.map((row) => {
    const out = { ...row };
    for (const f of deferred) out[f] = null;
    return out;
  });
}

/**
 * Models Prisma knows about that MODEL_ORDER forgot. Checked before every dump
 * and every restore, so a new table cannot quietly fall out of the backup.
 */
export function missingFromOrder() {
  return schemaModelNames().filter((name) => !MODEL_ORDER.includes(name));
}

/** Entries in MODEL_ORDER that no longer exist — a leftover after a rename. */
export function staleInOrder() {
  const names = schemaModelNames();
  return MODEL_ORDER.filter((name) => !names.includes(name));
}
