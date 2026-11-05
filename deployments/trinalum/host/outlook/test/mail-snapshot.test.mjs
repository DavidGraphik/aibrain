import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {tmpdir as nativeTmpdir} from 'node:os';
import {realpathSync as canonicalTmpPath} from 'node:fs';
const tmpdir=()=>canonicalTmpPath(nativeTmpdir());
import { writeMailSnapshot } from '../lib/mail-snapshot.mjs';

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'trinalum-mail-snapshot-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('publishes complete private JSON and leaves no temporary file', async t => {
  const path = await directory(t), destination = join(path, 'snapshot.json');
  const value = { mailbox: 'owner@example.test', data: { text: 'Confirmación íntegra' } };
  await writeMailSnapshot(destination, value);
  assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), value);
  assert.equal((await stat(destination)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(path), ['snapshot.json']);
});

test('disk exhaustion after a partial write preserves the previous valid snapshot', async t => {
  const path = await directory(t), destination = join(path, 'snapshot.json');
  const previous = { data: { text: 'Original completo' } };
  await writeMailSnapshot(destination, previous);
  const io = { rename, unlink, async open(...args) {
    const file = await open(...args);
    return {
      async writeFile() {
        await file.writeFile('{"data":');
        assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), previous);
        throw Object.assign(new Error('No space left'), { code: 'ENOSPC' });
      },
      sync: () => file.sync(), close: () => file.close(),
    };
  } };
  await assert.rejects(writeMailSnapshot(destination, { data: { text: 'Replacement' } }, io), { code: 'ENOSPC' });
  assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), previous);
  assert.deepEqual(await readdir(path), ['snapshot.json']);
});

test('a failed first write never publishes a truncated snapshot for readers', async t => {
  const path = await directory(t), destination = join(path, 'snapshot.json');
  const io = { rename, unlink, async open(...args) {
    const file = await open(...args);
    return {
      async writeFile() {
        await file.writeFile('');
        throw Object.assign(new Error('No space left'), { code: 'ENOSPC' });
      },
      sync: () => file.sync(), close: () => file.close(),
    };
  } };
  await assert.rejects(writeMailSnapshot(destination, { data: {} }, io), { code: 'ENOSPC' });
  assert.deepEqual(await readdir(path), []);
});

test('failure to publish rejects before a caller can advance the source cursor', async t => {
  const path = await directory(t), destination = join(path, 'snapshot.json');
  await writeFile(destination, JSON.stringify({ sourceUid: 1 }), { mode: 0o600 });
  let cursor = 1;
  const io = { open, unlink, async rename() { throw Object.assign(new Error('Read-only filesystem'), { code: 'EROFS' }); } };
  await assert.rejects((async () => {
    await writeMailSnapshot(destination, { sourceUid: 2 }, io);
    cursor = 2;
  })(), { code: 'EROFS' });
  assert.equal(cursor, 1);
  assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), { sourceUid: 1 });
  assert.deepEqual(await readdir(path), ['snapshot.json']);
});
