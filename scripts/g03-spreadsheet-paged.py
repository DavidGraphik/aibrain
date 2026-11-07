#!/usr/bin/env python3
"""Bounded text extraction; invoked in a networkless, unprivileged sandbox."""
import argparse
import datetime as dt
import hashlib
import json
import io
import math
from pathlib import Path
import re
import resource
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile

MAX_INPUT = 16 * 1024 * 1024
MAX_TEXT = 2 * 1024 * 1024
# Maximum full-workbook scan when paging; each response is still only 20k characters.
MAX_PAGED_SCAN_TEXT = 16 * 1024 * 1024
PAGE_CHARACTERS = 20000
MAX_XML = 24 * 1024 * 1024
FORMATS = {".pdf", ".pptx", ".docx", ".xlsx", ".xltx", ".xlsm", ".xls", ".xlsb", ".txt", ".asc", ".csv", ".md", ".json"}
SECRET = re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*|\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|password)\s*[:=]\s*[\"']?[A-Za-z0-9._~+/-]{16,}", re.I)


def require(ok, reason):
    if not ok:
        raise ValueError(reason)


def xml(archive, name):
    item = archive.getinfo(name)
    require(item.file_size <= MAX_XML, "XML_TOO_LARGE")
    data = archive.read(item)
    require(b"\x00" not in data, "XML_ENCODING_REJECTED")
    require(b"<!DOCTYPE" not in data.upper() and b"<!ENTITY" not in data.upper(), "XML_ENTITY_REJECTED")
    return ET.fromstring(data)


def spreadsheet(archive, text_limit=MAX_TEXT):
    """XML values only: no VBA, external links or formula evaluation."""
    ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    relns = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
    workbook = xml(archive, "xl/workbook.xml")
    targets = {}
    for rel in xml(archive, "xl/_rels/workbook.xml.rels"):
        target = rel.get("Target", "")
        if target.startswith("/xl/"):
            target = target[4:]
        if rel.get("TargetMode") != "External" and re.fullmatch(r"worksheets/[A-Za-z0-9_.-]+\.xml", target):
            targets[rel.get("Id")] = "xl/" + target
    strings = []
    if "xl/sharedStrings.xml" in archive.namelist():
        strings = ["".join(n.text or "" for n in item.iter(ns + "t"))
                   for item in xml(archive, "xl/sharedStrings.xml").iter(ns + "si")]
    formats = {14: "mm-dd-yy", 20: "h:mm", 21: "h:mm:ss", 22: "m/d/yy h:mm", 46: "[h]:mm:ss"}
    styles = []
    if "xl/styles.xml" in archive.namelist():
        style = xml(archive, "xl/styles.xml")
        formats.update({int(n.get("numFmtId")): n.get("formatCode", "") for n in style.iter(ns + "numFmt")})
        xfs = style.find(ns + "cellXfs")
        styles = [int(n.get("numFmtId", "0")) for n in xfs] if xfs is not None else []
    properties = workbook.find(ns + "workbookPr")
    date1904 = properties is not None and properties.get("date1904") in {"1", "true"}
    sheets = list(workbook.iter(ns + "sheet"))
    require(0 < len(sheets) <= 100, "SHEET_LIMIT")
    preview = {"schemaVersion": 1, "kind": "spreadsheet", "sheets": [], "truncated": False}
    budget = sum(len(sheet.get("name", "").encode("utf-8")) + 100 for sheet in sheets)
    visible_count = sum(sheet.get("state", "visible") == "visible" for sheet in sheets)
    hidden_count = len(sheets) - visible_count
    data_budget = 60000 - budget
    count, text_bytes = 0, 0
    lines = ["Valores guardados; macros desactivadas, fórmulas no recalculadas. Formatos no reconocidos: valor original."]
    for sheet in sheets:
        name = sheet.get("name", "")
        require(0 < len(name) <= 100, "INVALID_SHEET_NAME")
        target = targets.get(sheet.get(relns + "id"))
        require(target is not None, "INVALID_SHEET_TARGET")
        view = {"name": name, "hidden": sheet.get("state", "visible") != "visible", "cells": []}
        # A large hidden template must not starve the actual visible schedules.
        # Reserve a bounded share for every sheet while preserving workbook order.
        group_count = hidden_count if view["hidden"] else visible_count
        share = (0.05 if view["hidden"] else 0.95) if visible_count and hidden_count else 1
        sheet_limit, sheet_bytes = int(data_budget * share / group_count), 0
        preview["sheets"].append(view)
        lines.append("\nHoja: " + name + (" (oculta)" if view["hidden"] else ""))
        seen = set()
        for cell in xml(archive, target).iter(ns + "c"):
            count += 1
            # Excel may retain hundreds of thousands of style-only cells.
            # The XML/archive, CPU and memory bounds still apply independently.
            require(count <= 1000000, "CELL_LIMIT")
            address = cell.get("r", "")
            require(re.fullmatch(r"[A-Z]{1,3}[1-9][0-9]{0,6}", address) and address not in seen, "INVALID_CELL_ADDRESS")
            seen.add(address)
            value = cell.findtext(ns + "v", "")
            if cell.get("t") == "s":
                require(value.isdigit() and int(value) < len(strings), "INVALID_SHARED_STRING")
                value = strings[int(value)]
            elif cell.get("t") == "inlineStr":
                value = "".join(n.text or "" for n in cell.iter(ns + "t"))
            elif cell.get("t") == "b":
                value = "TRUE" if value == "1" else "FALSE"
            elif value and cell.get("t", "n") == "n":
                index = int(cell.get("s", "0"))
                code = formats.get(styles[index], "").lower() if 0 <= index < len(styles) else ""
                # Small explicit display subset; unknown formats retain original values.
                if code in {"h:mm", "hh:mm", "h:mm:ss", "hh:mm:ss", "[h]:mm:ss", "mm-dd-yy", "m/d/yy h:mm"}:
                    number = float(value)
                    require(math.isfinite(number) and 0 <= number < 2958466, "INVALID_DATE_VALUE")
                    seconds = round(number * 86400)
                    if code in {"mm-dd-yy", "m/d/yy h:mm"}:
                        if not date1904 and int(number) == 60:
                            value = "1900-02-29"
                            if code == "m/d/yy h:mm":
                                value += f" {seconds // 3600 % 24:02d}:{seconds // 60 % 60:02d}"
                        else:
                            epoch = dt.datetime(1904, 1, 1) if date1904 else dt.datetime(1899, 12, 31)
                            date = epoch + dt.timedelta(seconds=seconds - (86400 if not date1904 and number >= 60 else 0))
                            value = date.strftime("%Y-%m-%d" if code == "mm-dd-yy" else "%Y-%m-%d %H:%M")
                    else:
                        hours = seconds // 3600 if code.startswith("[h]") else seconds // 3600 % 24
                        value = f"{hours:02d}:{seconds // 60 % 60:02d}" + (f":{seconds % 60:02d}" if "ss" in code else "")
            if cell.find(ns + "f") is not None and not value:
                value = "[Fórmula sin valor guardado]"
            if not value:
                continue
            line = f"{address}: {value}"
            text_bytes += len(line.encode("utf-8")) + 1
            require(text_bytes <= text_limit, "TEXT_TOO_LARGE")
            lines.append(line)
            entry = {"address": address, "value": value}
            size = len(json.dumps(entry, ensure_ascii=False).encode("utf-8"))
            if budget + size <= 60000 and sheet_bytes + size <= sheet_limit and len(view["cells"]) < 2000:
                view["cells"].append(entry)
                budget += size
                sheet_bytes += size
            else:
                preview["truncated"] = True
    return "\n".join(lines), preview


def column_address(column):
    require(isinstance(column, int) and 0 <= column < 16384, "INVALID_CELL_ADDRESS")
    name = ""
    while column >= 0:
        name = chr(65 + column % 26) + name
        column = column // 26 - 1
    return name


class BinarySpreadsheetView:
    """Same bounded saved-value preview contract as the XML spreadsheet reader."""
    def __init__(self, sheets, warning):
        require(0 < len(sheets) <= 100, "SHEET_LIMIT")
        require(all(isinstance(name, str) and 0 < len(name) <= 100 for name, _ in sheets), "INVALID_SHEET_NAME")
        self.preview = {"schemaVersion": 1, "kind": "spreadsheet", "sheets": [], "truncated": False}
        self.lines = [warning]
        self.count, self.text_bytes = 0, len(warning.encode("utf-8"))
        self.budget = sum(len(name.encode("utf-8")) + 100 for name, _ in sheets)
        self.data_budget = 60000 - self.budget
        self.visible = sum(not hidden for _, hidden in sheets)
        self.hidden = len(sheets) - self.visible

    def sheet(self, name, hidden):
        self.current = {"name": name, "hidden": hidden, "cells": []}
        self.preview["sheets"].append(self.current)
        line = "\nHoja: " + name + (" (oculta)" if hidden else "")
        self.text_bytes += len(line.encode("utf-8")) + 1
        self.lines.append(line)
        group = self.hidden if hidden else self.visible
        share = (0.05 if hidden else 0.95) if self.visible and self.hidden else 1
        self.sheet_limit, self.sheet_bytes = int(self.data_budget * share / group), 0
        self.last_coordinate = (-1, -1)

    def cell(self, row, column, value):
        self.count += 1
        require(self.count <= 200000, "CELL_LIMIT")
        require(isinstance(row, int) and 0 <= row < 1048576, "INVALID_CELL_ADDRESS")
        require((row, column) > self.last_coordinate, "INVALID_CELL_ADDRESS")
        self.last_coordinate = (row, column)
        address = column_address(column) + str(row + 1)
        if value is None or value == "":
            return
        if isinstance(value, bool):
            value = "TRUE" if value else "FALSE"
        elif isinstance(value, (int, float)):
            require(math.isfinite(value), "INVALID_NUMBER_VALUE")
            value = str(value)
        else:
            require(isinstance(value, str), "INVALID_CELL_VALUE")
        line = f"{address}: {value}"
        self.text_bytes += len(line.encode("utf-8")) + 1
        require(self.text_bytes <= MAX_TEXT, "TEXT_TOO_LARGE")
        self.lines.append(line)
        entry = {"address": address, "value": value}
        size = len(json.dumps(entry, ensure_ascii=False).encode("utf-8"))
        if self.budget + size <= 60000 and self.sheet_bytes + size <= self.sheet_limit and len(self.current["cells"]) < 2000:
            self.current["cells"].append(entry)
            self.budget += size
            self.sheet_bytes += size
        else:
            self.preview["truncated"] = True

    def result(self):
        return "\n".join(self.lines), self.preview


def legacy_spreadsheet(source):
    """BIFF XLS: cached cell values only; no Excel, macros or external retrieval."""
    import xlrd
    require(xlrd.__version__ == "2.0.2", "XLS_READER_VERSION")
    require(xlrd.inspect_format(path=str(source)) == "xls", "INVALID_XLS_CONTAINER")
    book = xlrd.open_workbook(str(source), logfile=io.StringIO(), on_demand=True,
                             ragged_rows=True, use_mmap=False)
    try:
        require(0 < book.nsheets <= 100, "SHEET_LIMIT")
        # The pinned reader exposes workbook visibility without loading every sheet.
        names = book.sheet_names()
        sheets = [(name, bool(book._sheet_visibility[index])) for index, name in enumerate(names)]
        view = BinarySpreadsheetView(sheets, "Valores guardados XLS; macros desactivadas, fórmulas no recalculadas. Fechas tipadas en ISO; estilos de impresión no reproducidos.")
        for index, (name, hidden) in enumerate(sheets):
            sheet = book.sheet_by_index(index)
            require(0 <= sheet.nrows <= 1048576 and 0 <= sheet.ncols <= 16384, "INVALID_SHEET_DIMENSIONS")
            view.sheet(name, hidden)
            for row in range(sheet.nrows):
                for column, cell in enumerate(sheet.row(row)):
                    value = cell.value
                    if cell.ctype in {xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK}:
                        value = None
                    elif cell.ctype == xlrd.XL_CELL_DATE:
                        require(math.isfinite(value) and 0 <= value < 2958466, "INVALID_DATE_VALUE")
                        # Excel's fictitious leap day must not silently become 28 Feb.
                        if book.datemode == 0 and int(value) == 60:
                            value = "1900-02-29 (fecha ficticia de Excel)"
                        else:
                            value = xlrd.xldate_as_datetime(value, book.datemode).isoformat(sep=" ")
                    elif cell.ctype == xlrd.XL_CELL_BOOLEAN:
                        value = bool(value)
                    elif cell.ctype == xlrd.XL_CELL_ERROR:
                        value = xlrd.error_text_from_code.get(value, "[Error de Excel]")
                    view.cell(row, column, value)
            book.unload_sheet(index)
        return view.result()
    finally:
        book.release_resources()


def binary_sheet_cells(sheet):
    """Yield only stored BIFF12 cells, without synthesizing dense blank padding.

    The pinned pyxlsb rows() API fills every row to the worksheet width. Counting
    those artificial cells rejects sparse templates before their actual record
    budget. Keep the same budget, including stored BLANK records, by streaming
    the pinned reader's fixed record types instead. No formula tokens are run.
    """
    from pyxlsb import biff12
    reader = sheet._reader
    reader.seek(sheet._data_offset)
    row = -1
    ended = False
    for record, item in reader:
        if record == biff12.ROW:
            require(isinstance(item.r, int) and row < item.r < 1048576, "INVALID_CELL_ADDRESS")
            row = item.r
            require(sheet.dimension.r <= row < sheet.dimension.r + sheet.dimension.h, "INVALID_CELL_ADDRESS")
        elif biff12.BLANK <= record <= biff12.FORMULA_BOOLERR:
            require(row >= 0 and isinstance(item.c, int) and 0 <= item.c < sheet.dimension.c + sheet.dimension.w,
                    "INVALID_CELL_ADDRESS")
            value = item.v
            if record == biff12.STRING:
                require(sheet._stringtable is not None and isinstance(value, int) and value >= 0, "INVALID_SHARED_STRING")
                value = sheet._stringtable[value]
            yield row, item.c, value
        elif record == biff12.SHEETDATA_END:
            ended = True
            break
    require(ended, "INVALID_SHEET_DATA")


def binary_spreadsheet(source):
    """XLSB saved values. Numbers retain raw values: styles/dates are not inferred."""
    import pyxlsb
    from pyxlsb import biff12
    from pyxlsb.reader import BIFF12Reader
    from pyxlsb.handlers import SheetHandler
    require(pyxlsb.__version__ == "1.0.10", "XLSB_READER_VERSION")

    class VisibilityHandler(SheetHandler):
        def read(self, reader, recid, reclen):
            hidden = reader.read_int()
            require(hidden in {0, 1, 2}, "INVALID_SHEET_VISIBILITY")
            reader.seek(0)
            return super().read(reader, recid, reclen), hidden != 0

    with zipfile.ZipFile(source) as archive:
        validate_archive(archive)
        relations = xml(archive, "xl/_rels/workbook.bin.rels")
        ids, seen_ids = set(), set()
        for relationship in relations:
            relation_id = relationship.get("Id")
            require(relation_id and relation_id not in seen_ids, "INVALID_SHEET_TARGET")
            seen_ids.add(relation_id)
            if relationship.get("Type") != "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet":
                continue
            target = relationship.get("Target", "")
            # pyxlsb normalizes relationship paths; accept only exact internal paths.
            require(relationship.get("TargetMode") != "External" and
                    re.fullmatch(r"worksheets/[A-Za-z0-9_.-]+\.bin", target), "INVALID_SHEET_TARGET")
            require("xl/" + target in archive.namelist(), "INVALID_SHEET_TARGET")
            ids.add(relationship.get("Id"))
        reader = BIFF12Reader(io.BytesIO(archive.read("xl/workbook.bin")))
        reader.handlers = dict(reader.handlers)
        reader.register_handler(biff12.SHEET, VisibilityHandler())
        sheets = []
        for recid, item in reader:
            if recid == biff12.SHEET:
                sheet, hidden = item
                require(sheet.rId in ids, "INVALID_SHEET_TARGET")
                sheets.append((sheet.name, hidden))
                require(len(sheets) <= 100, "SHEET_LIMIT")
            elif recid == biff12.SHEETS_END:
                break
        view = BinarySpreadsheetView(sheets, "Valores guardados XLSB; macros desactivadas, fórmulas no recalculadas. Fechas, horas y formatos numéricos conservan su valor original sin interpretación; estilos de impresión no reproducidos.")
        # rels=False ensures worksheet hyperlinks are never processed/fetched.
        with pyxlsb.open_workbook(str(source)) as book:
            require(book.sheets == [name for name, _ in sheets], "INVALID_SHEET_MANIFEST")
            for index, (name, hidden) in enumerate(sheets, 1):
                view.sheet(name, hidden)
                with book.get_sheet(index, rels=False) as sheet:
                    dim = sheet.dimension
                    require(dim is not None and 0 <= dim.r < 1048576 and 0 < dim.h <= 1048576 - dim.r and
                            0 <= dim.c < 16384 and 0 < dim.w <= 16384 - dim.c, "INVALID_SHEET_DIMENSIONS")
                    for row, column, value in binary_sheet_cells(sheet):
                        view.cell(row, column, value)
        return view.result()


def validate_archive(archive):
    infos = archive.infolist()
    require(len(infos) <= 5000 and sum(i.file_size for i in infos) <= 64 * 1024 * 1024,
            "ARCHIVE_TOO_LARGE")
    require(len({i.filename for i in infos}) == len(infos), "DUPLICATE_ARCHIVE_MEMBER")


def presentation(archive):
    """Slide text in presentation order, without fetching links or running content."""
    ns = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
    drawing = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
    relns = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
    targets = {}
    for rel in xml(archive, "ppt/_rels/presentation.xml.rels"):
        target = rel.get("Target", "")
        if target.startswith("/ppt/"):
            target = target[5:]
        if rel.get("TargetMode") != "External" and re.fullmatch(r"slides/slide[0-9]+\.xml", target):
            require(rel.get("Id") not in targets, "DUPLICATE_SLIDE_RELATIONSHIP")
            targets[rel.get("Id")] = "ppt/" + target
    slides = list(xml(archive, "ppt/presentation.xml").iter(ns + "sldId"))
    require(0 < len(slides) <= 1000, "SLIDE_LIMIT")
    lines = ["Text de les diapositives. Les imatges i els gràfics no es transcriuen; no s'executa contingut actiu."]
    total = 0
    for number, slide in enumerate(slides, 1):
        target = targets.get(slide.get(relns + "id"))
        require(target is not None, "INVALID_SLIDE_TARGET")
        root = xml(archive, target)
        hidden = " (oculta)" if root.get("show") == "0" else ""
        lines.append(f"\nDiapositiva {number}{hidden}")
        for paragraph in root.iter(drawing + "p"):
            line = "".join((node.text or "") if node.tag == drawing + "t" else
                           "\n" if node.tag == drawing + "br" else "" for node in paragraph.iter())
            total += len(line.encode("utf-8")) + 1
            require(total <= MAX_TEXT, "TEXT_TOO_LARGE")
            if line:
                lines.append(line)
    return "\n".join(lines)


def measurement_text(raw):
    """Decode passive ASC reports, retaining strict binary/credential guards."""
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        # An explicit UTF-8 BOM is authoritative; do not hide malformed UTF-8.
        require(not raw.startswith(b"\xef\xbb\xbf"), "INVALID_UTF8_MEASUREMENT")
        text = raw.decode("cp1252")
    require(not any((ord(c) < 32 and c not in "\r\n\t") or
                    0x7f <= ord(c) <= 0x9f for c in text), "BINARY_CONTENT")
    return text


def extract(source, suffix, preview_result=None, text_limit=MAX_TEXT):
    require(type(text_limit) is int and text_limit in (MAX_TEXT, MAX_PAGED_SCAN_TEXT), "INVALID_TEXT_LIMIT")
    require(suffix in FORMATS and source.stat().st_size <= MAX_INPUT, "FORMAT_OR_SIZE_REJECTED")
    if suffix == ".pdf":
        # A regular temporary output makes RLIMIT_FSIZE effective for Poppler.
        output = Path("/tmp/extracted.txt")
        subprocess.run(["/usr/bin/pdftotext", "-layout", "-enc", "UTF-8", "-nopgbrk", str(source), str(output)],
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       check=True, timeout=25)
        require(output.stat().st_size <= MAX_TEXT, "TEXT_TOO_LARGE")
        text = output.read_text(encoding="utf-8")
    elif suffix in {".xls", ".xlsb"}:
        text, preview = legacy_spreadsheet(source) if suffix == ".xls" else binary_spreadsheet(source)
        if preview_result is not None:
            preview_result.update(preview)
    elif suffix in {".docx", ".xlsx", ".xltx", ".xlsm", ".xls", ".xlsb", ".pptx"}:
        with zipfile.ZipFile(source) as archive:
            validate_archive(archive)
            if suffix == ".docx":
                root = xml(archive, "word/document.xml")
                ns = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
                text = "\n".join("".join((n.text or "") if n.tag == ns + "t" else
                                         "\t" if n.tag == ns + "tab" else
                                         "\n" if n.tag in {ns + "br", ns + "cr"} else ""
                                         for n in p.iter()) for p in root.iter(ns + "p"))
            elif suffix == ".pptx":
                text = presentation(archive)
            else:
                text, preview = spreadsheet(archive, text_limit)
                if preview_result is not None:
                    preview_result.update(preview)
    else:
        raw = source.read_bytes()
        require(len(raw) <= MAX_TEXT, "TEXT_TOO_LARGE")
        text = measurement_text(raw) if suffix == ".asc" else raw.decode("utf-8-sig")
    text = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    require(text and len(text.encode("utf-8")) <= text_limit, "EMPTY_OR_OVERSIZED_TEXT")
    require(not any(ord(c) < 32 and c not in "\n\t" for c in text), "BINARY_CONTENT")
    require(not SECRET.search(text), "CREDENTIAL_SHAPED_CONTENT")
    return text


def extract_result(source, suffix, part=None):
    preview = {}
    if part is not None:
        require(suffix in {".xlsx", ".xltx", ".xlsm"} and type(part) is int and 1 <= part <= 999, "INVALID_PAGE")
    # Verify all workbook text for secrets and invalid content before releasing any page.
    text = extract(source, suffix, preview, MAX_PAGED_SCAN_TEXT if part is not None else MAX_TEXT)
    if part is not None:
        parts = (len(text) + PAGE_CHARACTERS - 1) // PAGE_CHARACTERS
        require(parts <= 999 and part <= parts, "SERVER_PART_UNAVAILABLE")
        result = {"ok": True, "text": text[(part - 1) * PAGE_CHARACTERS:part * PAGE_CHARACTERS], "page": part, "parts": parts}
    else:
        result = {"ok": True, "text": text}
    if preview:
        result["preview"] = preview
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--format", required=True, choices=sorted(FORMATS))
    parser.add_argument("--part", type=int)
    args = parser.parse_args()
    resource.setrlimit(resource.RLIMIT_AS, (384 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_CPU, (25, 25))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_TEXT + 1,) * 2)
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    try:
        result = extract_result(Path("/input"), args.format, args.part)
        result["sourceSha256"] = hashlib.sha256(Path("/input").read_bytes()).hexdigest()
    except Exception as error:
        result = {"ok": False, "reason": str(error) if isinstance(error, ValueError) else type(error).__name__}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
