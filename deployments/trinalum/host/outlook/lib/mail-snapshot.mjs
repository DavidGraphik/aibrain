import { open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Readers only enumerate .json. A failed/partial write must never publish one,
// replace an intact snapshot, or let its caller acknowledge the source cursor.
export async function writeMailSnapshot(destination, snapshot, io = { open, rename, unlink }) {
  const bytes = `${JSON.stringify(snapshot, null, 2)}\n`;
  const temporary = join(dirname(destination), `.mail-snapshot-${randomUUID()}.tmp`);
  let file;
  try {
    file = await io.open(temporary, 'wx', 0o600);
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    file = undefined;
    await io.rename(temporary, destination);
    const directory = await io.open(dirname(destination), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await file?.close();
    await io.unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
