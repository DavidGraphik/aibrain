/** Synthetic structural fixture. Its packet is not speech or a decoder acceptance. */
export function oggOpusFixture() {
  const head = Buffer.alloc(19);
  head.write("OpusHead"); head[8] = 1; head[9] = 1;
  head.writeUInt32LE(48000, 12);
  return Buffer.concat([page(head, 0, 2, 0n), page(Buffer.from("OpusTags\0\0\0\0\0\0\0\0"), 1, 0, 0n), page(Buffer.from([0xf8, 0xff, 0xfe]), 2, 4, 960n)]);
}

function page(payload: Buffer, sequence: number, flags: number, granule: bigint) {
  const header = Buffer.alloc(28);
  header.write("OggS"); header[5] = flags; header.writeBigUInt64LE(granule, 6);
  header.writeUInt32LE(123, 14); header.writeUInt32LE(sequence, 18);
  header[26] = 1; header[27] = payload.length;
  return repairOggChecksum(Buffer.concat([header, payload]));
}

// Deliberately independent, bitwise CRC reference for corruption tests.
export function repairOggChecksum(page: Buffer) {
  page.writeUInt32LE(0, 22);
  let crc = 0;
  for (const byte of page) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 0x80000000) ? (crc << 1) ^ 0x04c11db7 : crc << 1;
  }
  page.writeUInt32LE(crc >>> 0, 22);
  return page;
}
