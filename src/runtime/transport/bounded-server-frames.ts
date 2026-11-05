import { createHash, randomUUID } from 'node:crypto';

// Individual WebSocket frames keep their existing 8 MiB ceiling. A response
// may span bounded chunks; journals and callers receive only the complete,
// integrity-checked response. No partial response advances the durable cursor.
export const MAX_SERVER_MESSAGE_BYTES = 32 * 1024 * 1024;
const CHUNK_BYTES = 512 * 1024;
const FRAME_BYTES = 8 * 1024 * 1024;
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');

export function encodeServerFrames(serialized: string) {
  const bytes = Buffer.from(serialized, 'utf8');
  if (bytes.length <= FRAME_BYTES) return [serialized];
  if (bytes.length > MAX_SERVER_MESSAGE_BYTES) throw new Error('Worker response exceeds the bounded message limit.');
  const id = randomUUID();
  const sha256 = digest(bytes);
  const count = Math.ceil(bytes.length / CHUNK_BYTES);
  return Array.from({ length: count }, (_, index) => JSON.stringify({
    protocolVersion: 1, type: 'event-chunk', id, index, count,
    bytes: bytes.length, sha256,
    data: bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString('base64'),
  }));
}

export class ServerFrameAssembler {
  private pending: { id: string; count: number; bytes: number; sha256: string; chunks: Buffer[]; startedAt: number } | null = null;
  reset() { this.pending = null; }

  accept(raw: string): string | null {
    const frame: unknown = JSON.parse(raw);
    if (!frame || typeof frame !== 'object' || Array.isArray(frame) || !('type' in frame) || frame.type !== 'event-chunk') {
      if (this.pending && (!frame || typeof frame !== 'object' || !('type' in frame) || frame.type !== 'pong')) {
        this.reset();
        throw new Error('Worker interrupted an incomplete response.');
      }
      return raw;
    }
    try {
      const chunk = frame as Record<string, unknown>;
      if (Object.keys(chunk).sort().join(',') !== 'bytes,count,data,id,index,protocolVersion,sha256,type' ||
          chunk.protocolVersion !== 1 || typeof chunk.id !== 'string' || !/^[a-f0-9-]{36}$/u.test(chunk.id) ||
          !Number.isSafeInteger(chunk.bytes) || (chunk.bytes as number) <= FRAME_BYTES || (chunk.bytes as number) > MAX_SERVER_MESSAGE_BYTES ||
          chunk.count !== Math.ceil((chunk.bytes as number) / CHUNK_BYTES) || !Number.isSafeInteger(chunk.index) ||
          (chunk.index as number) < 0 || (chunk.index as number) >= (chunk.count as number) ||
          typeof chunk.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(chunk.sha256) ||
          typeof chunk.data !== 'string' || chunk.data.length > Math.ceil(CHUNK_BYTES / 3) * 4) throw new Error('Invalid worker response chunk.');
      const data = Buffer.from(chunk.data, 'base64');
      const expectedLength = Math.min(CHUNK_BYTES, (chunk.bytes as number) - (chunk.index as number) * CHUNK_BYTES);
      if (data.length !== expectedLength || data.toString('base64') !== chunk.data) throw new Error('Invalid worker response chunk encoding.');
      if (!this.pending) {
        if (chunk.index !== 0) throw new Error('Worker response chunks must start at zero.');
        this.pending = { id: chunk.id, count: chunk.count as number, bytes: chunk.bytes as number, sha256: chunk.sha256, chunks: [], startedAt: Date.now() };
      }
      const pending = this.pending;
      if (pending.id !== chunk.id || pending.count !== chunk.count || pending.bytes !== chunk.bytes ||
          pending.sha256 !== chunk.sha256 || pending.chunks.length !== chunk.index || Date.now() - pending.startedAt > 30_000) throw new Error('Worker response chunk sequence is invalid or expired.');
      pending.chunks.push(data);
      if (pending.chunks.length < pending.count) return null;
      const complete = Buffer.concat(pending.chunks, pending.bytes);
      this.reset();
      if (digest(complete) !== pending.sha256) throw new Error('Worker response integrity check failed.');
      const serialized = complete.toString('utf8');
      if (!Buffer.from(serialized).equals(complete)) throw new Error('Worker response is not valid UTF-8.');
      return serialized;
    } catch (error) { this.reset(); throw error; }
  }
}
