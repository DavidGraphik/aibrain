#!/usr/bin/env python3
"""Export the stored cell grid of an uploaded XLSX as bounded CSV text.

This reads OOXML data only. It never evaluates formulas, external references,
macros, or document instructions. The caller has already authorized and hash-
verified the uploaded bytes; this process enforces its own extraction limits.
"""

import csv
import json
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
import io
import posixpath
import re
import sys
import xml.etree.ElementTree as ET
from zipfile import BadZipFile, ZipFile

MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
CELL_REF = re.compile(r"^([A-Z]{1,3})([1-9][0-9]{0,6})$")
DATE_TOKENS = re.compile(r"(?<![a-z])[ymdhs]+(?![a-z])", re.I)
MAX_PART_BYTES = 16 * 1024 * 1024
MAX_SHEETS = 100
MAX_ROWS = 20_000
MAX_CELLS = 120_000
MAX_COLUMNS = 256
MAX_OUTPUT_BYTES = 2 * 1024 * 1024
MAX_PREVIEW_BYTES = 60_000
MAX_PREVIEW_CELLS_PER_SHEET = 2_000


def tag(name):
    return f"{{{MAIN}}}{name}"


def part(archive, name, max_bytes=MAX_PART_BYTES):
    info = archive.getinfo(name)
    if info.file_size > max_bytes:
        raise ValueError(f"XLSX part exceeds the safe extraction size: {name}")
    with archive.open(info) as stream:
        data = stream.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise ValueError(f"XLSX part exceeds the safe extraction size: {name}")
    return ET.fromstring(data)


def column_number(label):
    value = 0
    for character in label:
        value = value * 26 + ord(character) - 64
    return value


def column_label(number):
    label = ""
    while number:
        number, remainder = divmod(number - 1, 26)
        label = chr(65 + remainder) + label
    return label


def shared_strings(archive):
    if "xl/sharedStrings.xml" not in archive.namelist():
        return []
    root = part(archive, "xl/sharedStrings.xml")
    return ["".join("".join(node.itertext()) for node in item.findall(f".//{tag('t')}"))
            for item in root.findall(tag("si"))]


def date_styles(archive):
    if "xl/styles.xml" not in archive.namelist():
        return set()
    root = part(archive, "xl/styles.xml", 4 * 1024 * 1024)
    formats = {int(item.attrib["numFmtId"]): item.attrib.get("formatCode", "")
               for item in root.findall(f"{tag('numFmts')}/{tag('numFmt')}")}
    result = set()
    for index, xf in enumerate(root.findall(f"{tag('cellXfs')}/{tag('xf')}")):
        number_format = int(xf.attrib.get("numFmtId", "0"))
        if number_format in set(range(14, 23)) | set(range(45, 48)):
            result.add(index)
            continue
        fmt = formats.get(number_format, "")
        fmt = re.sub(r'"[^"]*"|\\.|\[[^]]*\]', "", fmt)
        if DATE_TOKENS.search(fmt):
            result.add(index)
    return result


def cell_text(cell, strings, dates, epoch):
    kind = cell.attrib.get("t", "n")
    value = cell.find(tag("v"))
    formula = cell.find(tag("f"))
    if kind == "inlineStr":
        inline = cell.find(tag("is"))
        return "" if inline is None else "".join(
            "".join(node.itertext()) for node in inline.findall(f".//{tag('t')}"))
    if value is None or value.text is None:
        return "#UNCALCULATED_FORMULA" if formula is not None else ""
    raw = value.text
    if kind == "s":
        index = int(raw)
        if index < 0 or index >= len(strings):
            raise ValueError("Invalid shared-string index")
        return strings[index]
    if kind == "b":
        return "TRUE" if raw == "1" else "FALSE"
    if kind in ("str", "e", "d"):
        return raw
    try:
        number = Decimal(raw)
    except InvalidOperation:
        raise ValueError("Invalid numeric cell") from None
    if int(cell.attrib.get("s", "0")) in dates:
        if not number.is_finite():
            raise ValueError("Invalid date cell")
        serial = float(number)
        if epoch == "1900" and int(serial) == 60:
            return "1900-02-29"
        origin = datetime(1899, 12, 30) if epoch == "1900" else datetime(1904, 1, 1)
        rendered = origin + timedelta(days=serial)
        return rendered.date().isoformat() if number == number.to_integral_value() else rendered.isoformat(sep=" ", timespec="seconds")
    return raw


def safe_text(value):
    return value.replace("\r", "\\r").replace("\n", "\\n").replace("\t", "\\t")


def workbook_text(archive):
    workbook = part(archive, "xl/workbook.xml", 4 * 1024 * 1024)
    relationships = part(archive, "xl/_rels/workbook.xml.rels", 4 * 1024 * 1024)
    rels = {item.attrib["Id"]: item.attrib["Target"]
            for item in relationships.findall(f"{{{PACKAGE_REL}}}Relationship")
            if item.attrib.get("Type", "").endswith("/worksheet")
            and item.attrib.get("TargetMode") != "External"}
    listed = workbook.findall(f"{tag('sheets')}/{tag('sheet')}")
    if not listed or len(listed) > MAX_SHEETS:
        raise ValueError("Invalid number of worksheets")
    props = workbook.find(tag("workbookPr"))
    epoch = "1904" if props is not None and props.attrib.get("date1904") in ("1", "true") else "1900"
    strings = shared_strings(archive)
    dates = date_styles(archive)
    output = io.StringIO(newline="")
    writer = csv.writer(output, lineterminator="\n")
    cell_count = 0
    for sheet in listed:
        name = sheet.attrib.get("name", "")
        relation = sheet.attrib.get(f"{{{REL}}}id")
        target = rels.get(relation)
        if not target:
            raise ValueError("Worksheet relationship is missing")
        file_name = posixpath.normpath(target.lstrip("/") if target.startswith("/")
                                      else posixpath.join("xl", target))
        if not file_name.startswith("xl/") or file_name not in archive.namelist():
            raise ValueError("Worksheet path is invalid")
        root = part(archive, file_name)
        rows = root.findall(f"{tag('sheetData')}/{tag('row')}")
        if len(rows) > MAX_ROWS:
            raise ValueError("Worksheet exceeds the safe row limit")
        last_column = max(
            (column_number(match.group(1))
             for row in rows for cell in row.findall(tag("c"))
             if (match := CELL_REF.match(cell.attrib.get("r", "")))),
            default=1,
        )
        if last_column > MAX_COLUMNS:
            raise ValueError("Worksheet exceeds the safe column limit")
        writer.writerow(["SHEET", safe_text(name), "hidden" if sheet.attrib.get("state", "visible") != "visible" else "visible"])
        writer.writerow(["ROW", *[column_label(index) for index in range(1, last_column + 1)]])
        for row in rows:
            number = int(row.attrib["r"])
            if number > MAX_ROWS:
                raise ValueError("Worksheet exceeds the safe row limit")
            values = [""] * last_column
            for cell in row.findall(tag("c")):
                address = cell.attrib.get("r", "")
                match = CELL_REF.match(address)
                if not match or int(match.group(2)) != number or column_number(match.group(1)) > last_column:
                    raise ValueError("Invalid cell address")
                cell_count += 1
                if cell_count > MAX_CELLS:
                    raise ValueError("Workbook exceeds the safe cell limit")
                value = cell_text(cell, strings, dates, epoch)
                values[column_number(match.group(1)) - 1] = safe_text(value)
            if any(values):
                writer.writerow([number, *values])
            if output.tell() > MAX_OUTPUT_BYTES:
                raise ValueError("Workbook exceeds the safe turn text size")
        writer.writerow([])
    return output.getvalue()


def workbook_preview(archive):
    """Return bounded saved cell values for the private, read-only grid."""
    workbook = part(archive, "xl/workbook.xml", 4 * 1024 * 1024)
    relationships = part(archive, "xl/_rels/workbook.xml.rels", 4 * 1024 * 1024)
    rels = {item.attrib["Id"]: item.attrib["Target"]
            for item in relationships.findall(f"{{{PACKAGE_REL}}}Relationship")
            if item.attrib.get("Type", "").endswith("/worksheet")
            and item.attrib.get("TargetMode") != "External"}
    listed = workbook.findall(f"{tag('sheets')}/{tag('sheet')}")
    if not listed or len(listed) > MAX_SHEETS:
        raise ValueError("Invalid number of worksheets")
    props = workbook.find(tag("workbookPr"))
    epoch = "1904" if props is not None and props.attrib.get("date1904") in ("1", "true") else "1900"
    strings = shared_strings(archive)
    dates = date_styles(archive)
    result = {"schemaVersion": 1, "kind": "spreadsheet", "sheets": [], "truncated": False}
    # Reserve every sheet's metadata before sampling cells. The remaining bytes
    # are shared fairly, so early/hidden sheets cannot exhaust later sheets.
    result["sheets"] = [{"name": sheet.attrib.get("name", "")[:100],
                         "hidden": sheet.attrib.get("state", "visible") != "visible",
                         "cells": [], "truncated": False} for sheet in listed]
    wire_overhead = len(json.dumps(result, ensure_ascii=False).encode("utf-8"))
    validation_overhead = sum(len(entry["name"].encode("utf-8")) + 100
                              for entry in result["sheets"])
    budget = MAX_PREVIEW_BYTES - max(wire_overhead, validation_overhead) - 1_000
    if budget < 0:
        raise ValueError("Workbook preview exceeds the safe output size")
    for index, sheet in enumerate(listed):
        relation = sheet.attrib.get(f"{{{REL}}}id")
        target = rels.get(relation)
        if not target:
            raise ValueError("Worksheet relationship is missing")
        file_name = posixpath.normpath(target.lstrip("/") if target.startswith("/")
                                      else posixpath.join("xl", target))
        if not file_name.startswith("xl/") or file_name not in archive.namelist():
            raise ValueError("Worksheet path is invalid")
        entry = result["sheets"][index]
        sheet_budget = budget // (len(listed) - index)
        root = part(archive, file_name)
        cell_limit_reached = False
        for row in root.findall(f"{tag('sheetData')}/{tag('row')}"):
            for cell in row.findall(tag("c")):
                address = cell.attrib.get("r", "")
                if not CELL_REF.match(address):
                    raise ValueError("Invalid cell address")
                value = cell_text(cell, strings, dates, epoch)
                if not value:
                    continue
                item = {"address": address, "value": value}
                size = len(json.dumps(item, ensure_ascii=False).encode("utf-8")) + 2
                if len(entry["cells"]) >= MAX_PREVIEW_CELLS_PER_SHEET:
                    entry["truncated"] = result["truncated"] = True
                    cell_limit_reached = True
                    break
                if size > sheet_budget:
                    entry["truncated"] = result["truncated"] = True
                    # One oversized cell must not conceal later small values.
                    continue
                entry["cells"].append(item)
                sheet_budget -= size
                budget -= size
            if cell_limit_reached:
                break
    return result


def main():
    preview = len(sys.argv) == 3 and sys.argv[1] == "--preview-json"
    if len(sys.argv) != (3 if preview else 2):
        raise ValueError("Expected one XLSX path")
    try:
        with ZipFile(sys.argv[2 if preview else 1]) as archive:
            result = workbook_preview(archive) if preview else workbook_text(archive)
    except (BadZipFile, KeyError, ET.ParseError) as error:
        raise ValueError("Invalid XLSX structure") from error
    if preview:
        output = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
        if len(output.encode("utf-8")) > MAX_PREVIEW_BYTES:
            raise ValueError("Workbook preview exceeds the safe output size")
        sys.stdout.write(output)
        return
    if len(result.encode("utf-8")) > MAX_OUTPUT_BYTES:
        raise ValueError("Workbook exceeds the safe turn text size")
    sys.stdout.write(result)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OverflowError) as error:
        sys.stderr.write(f"{error}\n")
        sys.exit(2)
