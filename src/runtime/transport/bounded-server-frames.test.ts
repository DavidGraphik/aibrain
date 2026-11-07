import { describe, expect, it } from 'vitest';
import { encodeServerFrames, MAX_SERVER_MESSAGE_BYTES, ServerFrameAssembler } from './bounded-server-frames';

describe('bounded worker response framing', () => {
  const message = JSON.stringify({ protocolVersion: 1, type: 'event', text: 'à😀'.repeat(2_000_000) + 'END' });
  it('delivers exact Unicode content above 8 MiB using small frames, once complete', () => {
    const frames = encodeServerFrames(message);
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every(frame => Buffer.byteLength(frame) < 8 * 1024 * 1024)).toBe(true);
    const reader = new ServerFrameAssembler();
    frames.slice(0, -1).forEach(frame => expect(reader.accept(frame)).toBeNull());
    expect(reader.accept(frames.at(-1)!)).toBe(message);
  });
  it('rejects corruption, duplicate/out-of-order chunks, metadata changes and oversized assembly', () => {
    const frames = encodeServerFrames(message);
    for (const mutation of [
      { ...JSON.parse(frames[1]), index: 0 },
      { ...JSON.parse(frames[1]), bytes: MAX_SERVER_MESSAGE_BYTES + 1 },
      { ...JSON.parse(frames[1]), sha256: 'f'.repeat(64) },
      { ...JSON.parse(frames[1]), data: 'AAAA' },
    ]) {
      const reader = new ServerFrameAssembler();
      reader.accept(frames[0]);
      expect(() => reader.accept(JSON.stringify(mutation))).toThrow();
    }
    const corrupt = frames.map((frame, index) => index === 1 ? JSON.stringify({ ...JSON.parse(frame), data: Buffer.alloc(512 * 1024, 65).toString('base64') }) : frame);
    const reader = new ServerFrameAssembler();
    expect(() => corrupt.forEach(frame => reader.accept(frame))).toThrow(/integrity/u);
    expect(() => encodeServerFrames('x'.repeat(MAX_SERVER_MESSAGE_BYTES + 1))).toThrow(/bounded/u);
  });
  it('drops incomplete assembly across disconnect and requires replay from the first chunk', () => {
    const frames = encodeServerFrames(message);
    const reader = new ServerFrameAssembler();
    reader.accept(frames[0]); reader.reset();
    expect(() => reader.accept(frames[1])).toThrow(/zero/u);
    const restored = frames.map(frame => reader.accept(frame)).filter(value => value !== null);
    expect(restored).toEqual([message]);
    expect(reader.accept('{"protocolVersion":1,"type":"pong"}')).toBe('{"protocolVersion":1,"type":"pong"}');
  });
});
