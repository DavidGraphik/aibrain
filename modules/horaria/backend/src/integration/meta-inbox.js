import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Validate the whole batch before acknowledging any part of it. A Meta app
// signature alone does not identify this installation's account or number.
export function metaMessages(body, { wabaId, phoneId }) {
  if (!wabaId || !phoneId) throw new Error('WhatsApp account binding is missing');
  if (body?.object !== 'whatsapp_business_account' || !Array.isArray(body.entry) || !body.entry.length) throw new Error('Invalid WhatsApp event');
  const messages = [];
  for (const entry of body.entry) {
    if (entry.id !== wabaId || !Array.isArray(entry.changes)) throw new Error('Unexpected WhatsApp account');
    for (const change of entry.changes) {
      const value = change.value;
      if (typeof change.field !== 'string') throw new Error('Invalid WhatsApp event field');
      // Account/template notifications share this callback. They carry no
      // employee messages and need no phone binding or business effects.
      if (change.field !== 'messages') continue;
      if (value?.metadata?.phone_number_id !== phoneId) throw new Error('Unexpected WhatsApp number');
      if (value.messages !== undefined && !Array.isArray(value.messages)) throw new Error('Invalid messages');
      for (const message of value.messages || []) {
        if (typeof message.id !== 'string' || !message.id || message.id.length > 512 || !/^\d{6,20}$/.test(message.from || '') || typeof message.type !== 'string') throw new Error('Invalid message');
        messages.push(message);
      }
    }
  }
  if (messages.length > 100) throw new Error('Too many messages');
  return messages;
}

// Single supervised process per installation. Persist before HTTP 200 and keep
// a terminal receipt. An interrupted effect is uncertain, never replayed blindly.
export class MetaInbox {
  constructor({ root, installationId, processMessage, authorize, maxRecords = 10000, onError = () => {} }) {
    this.root = path.join(root, 'whatsapp-inbox');
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const info = lstatSync(this.root);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('WhatsApp inbox must be private');
    this.installationId = installationId; this.processMessage = processMessage;
    this.authorize = authorize; this.maxRecords = maxRecords; this.onError = onError;
    this.running = null; this.stopped = false;
    this.sequence = 0;
    for (const name of this.names()) {
      const record = this.read(name);
      this.sequence = Math.max(this.sequence, record.sequence || 0);
      if (record.status === 'processing') this.write(name, { ...record, status: 'uncertain', updatedAt: Date.now() });
    }
  }
  names() { return readdirSync(this.root).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort(); }
  read(name) {
    const file = path.join(this.root, name), info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || info.size > 1024 * 1024) throw new Error('Invalid inbox record');
    const record = JSON.parse(readFileSync(file, 'utf8'));
    if (record.installationId !== this.installationId) throw new Error('Foreign inbox record');
    return record;
  }
  write(name, record) {
    const temporary = path.join(this.root, `.${randomUUID()}.pending`);
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); } finally { closeSync(fd); }
    try { renameSync(temporary, path.join(this.root, name)); }
    catch (error) { unlinkSync(temporary); throw error; }
    const directory = openSync(this.root, 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  enqueue(messages, identity) {
    if (this.stopped) throw new Error('Inbox is stopping');
    if (identity.installationId !== this.installationId || typeof identity.actorId !== 'string' || !identity.actorId || !Number.isSafeInteger(identity.employeeId) || identity.employeeId < 1) throw new Error('Missing event identity');
    const entries = messages.map(message => ({ message, name: createHash('sha256').update(message.id).digest('hex') + '.json' }));
    const names = new Set(this.names());
    const newNames = new Set(entries.filter(entry => !names.has(entry.name)).map(entry => entry.name));
    if (names.size + newNames.size > this.maxRecords) throw new Error('Inbox capacity reached; operator review required');
    for (const { message, name } of entries) {
      if (existsSync(path.join(this.root, name))) continue;
      this.write(name, { installationId: this.installationId, identity: { actorId: identity.actorId, employeeId: identity.employeeId }, message, status: 'queued', sequence: ++this.sequence, createdAt: Date.now(), updatedAt: Date.now() });
    }
    this.kick();
  }
  kick() {
    if (!this.running && !this.stopped) {
      this.running = Promise.resolve().then(() => this.drain()).catch(() => this.onError('inbox_failure')).finally(() => { this.running = null; });
    }
    return this.running;
  }
  async drain() {
    while (!this.stopped) {
      const next = this.names().map(name => ({ name, record: this.read(name) })).filter(({ record }) => record.status === 'queued').sort((a, b) => a.record.sequence - b.record.sequence)[0];
      if (!next) return;
      const { name, record } = next;
      try { await this.authorize(record.identity); }
      catch { this.write(name, { ...record, status: 'blocked', updatedAt: Date.now() }); this.onError('identity_blocked'); continue; }
      this.write(name, { ...record, status: 'processing', updatedAt: Date.now() });
      try {
        await this.processMessage(record.message, record.identity);
        // Keep deduplication and outcome, not message contents, after completion.
        this.write(name, { installationId: this.installationId, status: 'completed', sequence: record.sequence, createdAt: record.createdAt, updatedAt: Date.now() });
      } catch {
        this.write(name, { ...record, status: 'uncertain', updatedAt: Date.now() });
        this.onError('message_uncertain');
      }
    }
  }
  summary() {
    const counts = {};
    for (const name of this.names()) { const { status } = this.read(name); counts[status] = (counts[status] || 0) + 1; }
    return counts;
  }
  async stop() { this.stopped = true; await this.running; }
}
