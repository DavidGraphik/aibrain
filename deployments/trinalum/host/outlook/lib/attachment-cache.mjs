import { mkdir, lstat, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Only mailbox/content-hashed cache names belong here. Never open the old
// target: a root-created 0600 cache entry is unreadable by the connector user.
export async function writePrivateAttachment(directory, name, content) {
  if (!/^[a-f0-9]{64}\.(pdf|bin)$/.test(name)) {
    throw new Error('Invalid attachment cache name');
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const owner = await lstat(directory);
  if (!owner.isDirectory()) throw new Error('Attachment cache must be a directory');
  const temporary = join(directory, `.attachment-${randomUUID()}.tmp`);
  const destination = join(directory, name);
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    // Operator reads must produce the same private cache ownership as service
    // reads. This affects only the new file, never an existing file or ACL.
    if (process.getuid?.() === 0) await file.chown(owner.uid, owner.gid);
    await file.writeFile(content);
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, destination);
    return destination;
  } finally {
    await file?.close();
    await unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
