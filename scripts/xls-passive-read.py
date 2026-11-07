"""Read bounded BIFF8 values only. Never open an XLS in Office or evaluate formulas.

Production invocation is exclusively through the networkless xls-passive wrapper.
Input is the root Workbook stream extracted by the CFB validator, not the CFB or
its VBA/embedded streams. Output stays private and is never written to logs.
"""
import contextlib
import io
import json
import math
import os
import resource
import struct
import sys
from pathlib import Path

MAX_INPUT = 16 * 1024 * 1024
MAX_OUTPUT = 40 * 1024 * 1024
MAX_CELLS = 500_000
MAX_FORMULAS = 100_000


def require(condition):
    if not condition:
        raise ValueError('unsupported-passive-workbook')


def framing(data):
    """Verify record framing before xlrd sees cell/string allocation metadata."""
    at = 0
    current = None
    streams = {}
    bounds = []
    links = 0
    records = 0
    while at < len(data):
        if current is None and not any(data[at:]):
            break
        require(at + 4 <= len(data))
        ident, size = struct.unpack_from('<HH', data, at)
        require(size <= 8224 and at + size + 4 <= len(data))
        body = data[at + 4:at + 4 + size]
        records += 1
        require(records <= 1_000_000)
        if ident == 0x2f:
            raise ValueError('encrypted-workbook')
        if ident == 0x809:
            require(current is None and size >= 8)
            version, kind = struct.unpack_from('<HH', body)
            require(version == 0x600 and kind in (5, 0x10, 0x20, 0x40))
            require(len(streams) < 301 and (at != 0 or kind == 5))
            current = {'kind': kind, 'formulas': {}, 'shared': {}}
            streams[at] = current
        elif ident == 0x0a:
            require(current is not None and size == 0)
            current = None
        else:
            require(current is not None)
        if ident == 0x85:
            require(current['kind'] == 5 and size >= 8)
            target = struct.unpack_from('<I', body)[0]
            require(body[5] in (0, 1, 2) and len(bounds) < 100)
            bounds.append((target, body[5]))
        if ident in (0x1b8, 0x1b2, 0x23, 0x59, 0x1ae):
            links += 1
        if ident == 6 and current['kind'] == 0x10:
            require(size >= 22)
            row, col = struct.unpack_from('<HH', body)
            length = struct.unpack_from('<H', body, 20)[0]
            require(col < 256 and length <= size - 22)
            require((row, col) not in current['formulas'])
            missing = body[12:14] == b'\xff\xff' and body[6] == 3
            current['formulas'][(row, col)] = (body[22:22 + length], missing)
            require(sum(len(s['formulas']) for s in streams.values()) <= MAX_FORMULAS)
        if ident == 0x4bc and current['kind'] == 0x10:
            require(size >= 10)
            row = struct.unpack_from('<H', body)[0]
            col = body[4]
            length = struct.unpack_from('<H', body, 8)[0]
            require(length <= size - 10 and (row, col) not in current['shared'])
            current['shared'][(row, col)] = body[10:10 + length]
        at += size + 4
    require(current is None and bounds and len({target for target, _ in bounds}) == len(bounds))
    require(sum(s['kind'] == 5 for s in streams.values()) == 1)
    for target, kind in bounds:
        require(target in streams and streams[target]['kind'] == {0: 0x10, 1: 0x40, 2: 0x20}[kind])
    return streams, bounds, links


def extract(data):
    import xlrd
    from xlrd.formula import decompile_formula, FMLA_TYPE_CELL, FMLA_TYPE_SHARED
    require(xlrd.__version__ == '2.0.2')
    streams, bounds, links = framing(data)
    # Suppress parser diagnostics that could contain names or cell contents.
    quiet = io.StringIO()
    with contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
        book = xlrd.open_workbook(file_contents=data, on_demand=True,
                                  formatting_info=True, ragged_rows=True, logfile=quiet)
        require(book.biff_version == 80 and 0 < book.nsheets <= 100 and book.datemode in (0, 1))
        sheets = []
        cell_count = 0
        formula_count = 0
        missing_count = 0
        undecoded = 0
        for index in range(book.nsheets):
            sheet = book.sheet_by_index(index)
            require(sheet.nrows <= 65536 and sheet.ncols <= 256)
            require(sheet.nrows * sheet.ncols <= 1_000_000)
            source = streams.get(book._sh_abs_posn[index])
            require(source is not None and source['kind'] == 0x10)
            cells = []
            formulas = []
            for row in range(sheet.nrows):
                for col in range(sheet.row_len(row)):
                    cell = sheet.cell(row, col)
                    formula = source['formulas'].get((row, col))
                    if cell.ctype in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK) and formula is None:
                        continue
                    value = cell.value
                    typ = {xlrd.XL_CELL_EMPTY: 'text', xlrd.XL_CELL_BLANK: 'text',
                           xlrd.XL_CELL_TEXT: 'text', xlrd.XL_CELL_NUMBER: 'number',
                           xlrd.XL_CELL_DATE: 'date', xlrd.XL_CELL_BOOLEAN: 'boolean',
                           xlrd.XL_CELL_ERROR: 'error'}.get(cell.ctype)
                    require(typ is not None)
                    if typ in ('number', 'date'):
                        require(isinstance(value, (int, float)) and math.isfinite(value))
                    elif typ == 'error':
                        value = xlrd.error_text_from_code.get(value, '#N/A')
                    elif typ == 'boolean':
                        value = bool(value)
                    else:
                        require(isinstance(value, str) and len(value) <= 32767)
                    if formula:
                        tokens, missing = formula
                        formula_count += 1
                        if missing:
                            missing_count += 1
                            typ, value = 'text', '#UNVERIFIED_FORMULA_NO_SAVED_VALUE'
                        formula_text = '[formula not decoded]'
                        try:
                            mode = FMLA_TYPE_CELL
                            if tokens and tokens[0] == 1:
                                shared_row, shared_col = struct.unpack_from('<HH', tokens, 1)
                                tokens = source['shared'][(shared_row, shared_col)]
                                mode = FMLA_TYPE_SHARED
                            decoded = decompile_formula(book, tokens, len(tokens), fmlatype=mode, browx=row, bcolx=col)
                            if isinstance(decoded, str) and len(decoded) <= 32767:
                                formula_text = decoded
                            else:
                                undecoded += 1
                        except Exception:
                            undecoded += 1
                        formulas.append([row, col, formula_text, 'missing' if missing else 'unverified'])
                    cells.append([row, col, typ, value, formula is not None])
                    cell_count += 1
                    require(cell_count <= MAX_CELLS)
            sheets.append({'name': sheet.name, 'cells': cells, 'formulas': formulas})
            book.unload_sheet(index)
        book.release_resources()
    require(cell_count > 0)
    require(formula_count == sum(len(s['formulas']) for s in streams.values() if s['kind'] == 0x10))
    return {'schemaVersion': 1, 'reader': 'xlrd-2.0.2', 'date1904': book.datemode == 1,
            'sheets': sheets, 'cellCount': cell_count, 'formulaCount': formula_count,
            'missingFormulaCaches': missing_count, 'undecodedFormulas': undecoded,
            'omittedSheets': len(bounds) - len(sheets), 'linkRecords': links}


def main():
    # Refuse accidental direct execution outside the minimal production namespace.
    require(sys.platform == 'linux' and Path.cwd() == Path('/work'))
    require(all(not Path(root).exists() for root in ('/var', '/etc', '/app', '/proc', '/sys', '/home', '/run')))
    resource.setrlimit(resource.RLIMIT_CPU, (30, 35))
    resource.setrlimit(resource.RLIMIT_AS, (768 * 1024 * 1024, 768 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_OUTPUT, MAX_OUTPUT))
    require(len(sys.argv) == 1)
    source = Path('source.biff')
    require(source.is_file() and not source.is_symlink() and 12 <= source.stat().st_size <= MAX_INPUT)
    result = extract(source.read_bytes())
    encoded = json.dumps(result, ensure_ascii=True, allow_nan=False, separators=(',', ':')).encode('ascii')
    require(len(encoded) <= MAX_OUTPUT)
    with open('output/result.json', 'xb') as out:
        os.chmod('output/result.json', 0o600)
        out.write(encoded)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Deliberately do not print exception messages, names or document data.
        sys.stderr.write('PASSIVE_XLS_EXTRACTION_FAILED\n')
        sys.exit(65)
