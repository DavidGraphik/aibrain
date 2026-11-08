// The public chat transport deliberately hides UUIDs and hashes. Give the
// model harmless, batch-local references, then restore IDs only on the host.
export function prepareRoutedInput(job, input) {
  if (!['email-event-router', 'sibema-event-router'].includes(job))
    return { modelInput: input, restoreResult: text => text };
  const marker = job === 'email-event-router' ? 'MAIL_BATCH_JSON' : 'SIBEMA_BATCH_JSON';
  const boundary = input.lastIndexOf('\n' + marker + '\n');
  if (boundary < 0) throw Error('AUTOMATION_SOURCE_BATCH_MISSING');
  const start = boundary + marker.length + 2;
  const batch = JSON.parse(input.slice(start).trim());
  const rows = batch.messages ?? batch.events;
  if (!Array.isArray(rows) || !rows.length) throw Error('AUTOMATION_SOURCE_ROWS_MISSING');
  const ids = rows.map(row => row.snapshot_id);
  if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length)
    throw Error('AUTOMATION_SOURCE_IDS_INVALID');
  const aliases = new Map();
  rows.forEach((row, index) => {
    const alias = `SNAPSHOT_${String(index + 1).padStart(4, '0')}`;
    aliases.set(alias, row.snapshot_id);
    row.snapshot_id = alias;
  });
  const modelInput = input.slice(0, boundary) +
    '\nConserva literalmente cada referencia SNAPSHOT_XXXX en results y processed_snapshot_ids. Devuelve una fila por referencia; no agrupes ni omitas registros duplicados.\n' +
    input.slice(boundary, start) + JSON.stringify(batch);
  return { modelInput, restoreResult(text) {
    let result;
    for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
      try { const candidate = JSON.parse(match[1]); if (Array.isArray(candidate.results)) { result = candidate; break; } } catch {}
    }
    if (!result) { try { result = JSON.parse(text); } catch {} }
    if (!Array.isArray(result?.results) || !Array.isArray(result.processed_snapshot_ids))
      throw Error('AUTOMATION_SOURCE_RESULT_INVALID');
    const resolve = alias => {
      if (!aliases.has(alias)) throw Error('AUTOMATION_SOURCE_REFERENCE_UNKNOWN');
      return aliases.get(alias);
    };
    // Cross-references (for example duplicate_of_snapshot_id), nested source
    // arrays and task descriptions must refer to the same original snapshots.
    // A batch-local placeholder is never a durable provider reference.
    const restore = value => {
      if (typeof value === 'string')
        return value.replace(/\bSNAPSHOT_\d{4,}\b/g, resolve);
      if (Array.isArray(value)) return value.map(restore);
      if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restore(item)]));
      return value;
    };
    // Required identity fields must themselves be exact aliases, not prose.
    for (const row of result.results) resolve(row.snapshot_id);
    result.processed_snapshot_ids.forEach(resolve);
    return '```json\n' + JSON.stringify(restore(result)) + '\n```';
  } };
}
