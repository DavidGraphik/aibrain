class UploadValidationError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
// Initial server budget is measured for short voice notes; bound decoded PCM too.
export const MAX_AUDIO_SECONDS = 5 * 60;

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value << 24;
  for (let bit = 0; bit < 8; bit++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
  return crc >>> 0;
});

export function oggPageChecksum(page) {
  let crc = 0;
  for (let index = 0; index < page.length; index++) {
    const byte = index >= 22 && index < 26 ? 0 : page[index];
    crc = ((crc << 8) ^ crcTable[((crc >>> 24) ^ byte) & 255]) >>> 0;
  }
  return crc;
}

/** Complete pages of one non-multiplexed Ogg Opus recording; no extension-only admission. */
export function inspectOggOpus(data) {
  if (!data.length || data.length > MAX_AUDIO_BYTES) {
    throw new UploadValidationError("UPLOAD_SIZE_INVALID", "Audio exceeds the safety limit.");
  }
  const invalid = () => { throw new UploadValidationError("UPLOAD_AUDIO_INVALID", "Audio must be a complete bounded Ogg Opus stream."); };
  let offset = 0;
  let sequence = 0;
  let serial = null;
  let continued = false;
  let packets = 0;
  let packetBytes = 0;
  let ended = false;
  let lastGranule = 0n;
  let finalGranule = 0n;
  while (offset < data.length) {
    if (ended || offset + 27 > data.length) invalid();
    const header = data.subarray(offset, offset + 27);
    const flags = header[5];
    const segments = header[26];
    if (header.toString("ascii", 0, 4) !== "OggS" || header[4] !== 0 || (flags & ~7) !== 0 ||
        Boolean(flags & 1) !== continued || Boolean(flags & 2) !== (sequence === 0) ||
        header.readUInt32LE(18) !== sequence || !segments || offset + 27 + segments > data.length) invalid();
    const pageSerial = header.readUInt32LE(14);
    if (serial !== null && serial !== pageSerial) invalid();
    serial = pageSerial;
    const laces = data.subarray(offset + 27, offset + 27 + segments);
    const payloadBytes = laces.reduce((sum, size) => sum + size, 0);
    const end = offset + 27 + segments + payloadBytes;
    if (end > data.length || oggPageChecksum(data.subarray(offset, end)) !== header.readUInt32LE(22)) invalid();
    let cursor = offset + 27 + segments;
    for (const size of laces) {
      if (packets === 0) {
        if (sequence !== 0 || segments !== 1 || size !== 19) invalid();
        const head = data.subarray(cursor, cursor + size);
        if (head.toString("ascii", 0, 8) !== "OpusHead" || head[8] !== 1 ||
            ![1, 2].includes(head[9]) || head[18] !== 0) invalid();
      } else if (packets === 1 && packetBytes === 0 && data.toString("ascii", cursor, cursor + 8) !== "OpusTags") invalid();
      packetBytes += size;
      if (packetBytes > 64 * 1024) invalid();
      cursor += size;
      if (size < 255) { packets++; packetBytes = 0; }
    }
    continued = laces.at(-1) === 255;
    const granule = header.readBigUInt64LE(6);
    finalGranule = granule;
    if (granule !== 0xffffffffffffffffn) {
      if (granule < lastGranule || granule > BigInt(MAX_AUDIO_SECONDS * 48000 + 65535)) invalid();
      lastGranule = granule;
    }
    ended = Boolean(flags & 4);
    if (ended && (continued || packets < 3 || lastGranule === 0n || granule === 0xffffffffffffffffn)) invalid();
    offset = end;
    sequence++;
  }
  // Mobile recorders (including the supplied originals) may omit EOS. Require
  // complete final pages/packets and a positive bounded sample position; the
  // decoder probe below still verifies the actual codec and duration.
  if (continued || packetBytes !== 0 || packets < 3 || lastGranule === 0n || finalGranule === 0xffffffffffffffffn) invalid();
}
