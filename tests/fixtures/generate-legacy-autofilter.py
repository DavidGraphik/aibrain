"""Optional fixture regeneration (requires xlwt); all values are fictional.

From the repo root, pipe JSON from the TypeScript structural builder:
node --import tsx tests/fixtures/legacy-autofilter-profiles.ts | python3 tests/fixtures/generate-legacy-autofilter.py
CI reads the committed XLS fixtures and needs no Python dependency.
"""
import base64
import json
import struct
import sys
from pathlib import Path

import xlwt
from xlwt.CompoundDoc import XlsDoc


def record(ident, body):
    return struct.pack('<HH', ident, len(body)) + body


for scenario in json.load(sys.stdin):
    book = xlwt.Workbook()
    for index, profile in enumerate(scenario['sheets']):
        sheet = book.add_sheet(f"Test {scenario['name']} {index + 1}")
        for col in range(profile['filterColumns']):
            sheet.write(0, col, f'Columna fictícia {col + 1}')
            sheet.write(1, col, (index + 1) * 100 + col + 0.25)
            sheet.write(2, col, xlwt.Formula(f'{xlwt.Utils.rowcol_to_cell(1, col)}*2'))

    workbook = book.get_biff_data()
    rows = []
    at = 0
    while at + 4 <= len(workbook):
        ident, size = struct.unpack_from('<HH', workbook, at)
        rows.append((at, ident, size))
        at += 4 + size
    assert at == len(workbook)

    eof_offsets = [at for at, ident, _ in rows if ident == 0x0a]
    assert len(eof_offsets) == len(scenario['sheets']) + 1
    insertions = {eof_offsets[0]: record(0xeb, base64.b64decode(scenario['global']))}
    for eof, profile in zip(eof_offsets[1:], scenario['sheets']):
        insertions[eof] = record(0x9d, struct.pack('<H', profile['filterColumns'])) + b''.join(
            record(0xec, base64.b64decode(pair['drawing'])) + record(0x5d, base64.b64decode(pair['object']))
            for pair in profile['pairs']
        )

    def shifted(offset):
        return offset + sum(len(data) for where, data in insertions.items() if where <= offset)

    output = bytearray()
    for at, ident, size in rows:
        output += insertions.get(at, b'')
        output += workbook[at:at + size + 4]
        if ident == 0x85:
            target = struct.unpack_from('<I', workbook, at + 4)[0]
            struct.pack_into('<I', output, shifted(at) + 4, shifted(target))

    suffix = '' if scenario['name'] == 'basic' else f"-{scenario['name']}"
    destination = Path(__file__).resolve().parent / f"legacy-autofilter{suffix}.xls"
    XlsDoc().save(str(destination), output)
    print(f'Generated {destination.name}: {destination.stat().st_size} bytes')
