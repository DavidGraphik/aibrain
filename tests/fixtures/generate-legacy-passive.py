"""Fictional macro/link carrier; inert payload, never executable VBA/XLM."""
import io, math, struct
from pathlib import Path
import xlrd

root = Path(__file__).resolve().parent
raw = xlrd.compdoc.CompDoc((root / 'legacy-autofilter.xls').read_bytes(), logfile=io.StringIO()).get_named_stream('Workbook')
at = 0
rows = []
while at + 4 <= len(raw):
    ident, size = struct.unpack_from('<HH', raw, at)
    if not ident and not size and not any(raw[at:]):
        raw = raw[:at]
        break
    rows.append((at, ident, size))
    at += size + 4
# A syntactically valid hyperlink moniker; the address is never opened.
url = 'https://example.invalid/do-not-open\0'.encode('utf-16le')
hlink = struct.pack('<HHHH', 0, 0, 0, 0) + bytes.fromhex('d0c9ea79f9bace118c8200aa004ba90b') + struct.pack('<II', 2, 3)
hlink += bytes.fromhex('e0c9ea79f9bace118c8200aa004ba90b') + struct.pack('<I', len(url)) + url
record = struct.pack('<HH', 0x1b8, len(hlink)) + hlink
eof = [at for at, ident, size in rows if ident == 0x0a][-1]
raw = raw[:eof] + record + raw[eof:]
workbook = raw.ljust(max(4096, len(raw)), b'\0')
payload = b'INERT_TEST_VBA_PAYLOAD_DO_NOT_EXECUTE'.ljust(4096, b'\0')


def entry(name, typ, left=-1, right=-1, child=-1, start=-2, size=0):
    data = bytearray(128)
    name = (name + '\0').encode('utf-16le')
    data[:len(name)] = name
    struct.pack_into('<HBBiii', data, 64, len(name), typ, 1, left, right, child)
    struct.pack_into('<iQ', data, 116, start, size)
    return bytes(data)


nwb = math.ceil(len(workbook) / 512)
fat_id, dir_id = nwb + 8, nwb + 9
header = bytearray(512)
header[:8] = bytes.fromhex('d0cf11e0a1b11ae1')
struct.pack_into('<HHHHH', header, 24, 0x3e, 3, 0xfffe, 9, 6)
struct.pack_into('<IIIIiiIiI', header, 40, 0, 1, dir_id, 0, 4096, -2, 0, -2, 0)
struct.pack_into('<109i', header, 76, fat_id, *([-1] * 108))
fat = [-1] * 128
for start, count in [(0, nwb), (nwb, 8)]:
    for i in range(count): fat[start + i] = start + i + 1 if i < count - 1 else -2
fat[fat_id], fat[dir_id] = -3, -2
directory = entry('Root Entry', 5, child=1) + entry('Workbook', 2, right=2, start=0, size=len(workbook))
directory += entry('_VBA_PROJECT_CUR', 1, child=3) + entry('Module1', 2, start=nwb, size=len(payload))
output = header + workbook.ljust(nwb * 512, b'\0') + payload + struct.pack('<128i', *fat) + directory
(root / 'legacy-passive-links-macros.xls').write_bytes(output)
print('Generated inert macro/link carrier:', len(output), 'bytes')
