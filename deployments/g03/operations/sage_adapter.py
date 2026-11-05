"""Offline Sage boundary. Validation/normalization only; zero HTTP or SQL calls.

Synthetic schema is ours, not a claim about Sage's actual API.
No credentials, writes, or dispatch. A provider-approved mapping is still needed.
"""
import csv
import datetime as dt
import hashlib
import io
import math


def preview_sales_export(contents, source="synthetic-fixture"):
    if source != "synthetic-fixture": raise ValueError("LIVE_MAPPING_UNCONFIRMED")
    if not isinstance(contents, str) or len(contents.encode()) > 100_000: raise ValueError("EXPORT_LIMIT")
    reader = csv.DictReader(io.StringIO(contents))
    expected = {"salesOrder", "line", "client", "reference", "quantity", "deliveryDate"}
    if set(reader.fieldnames or []) != expected or len(reader.fieldnames or []) != len(expected): raise ValueError("SCHEMA_UNCONFIRMED")
    normalized, seen = [], set()
    for row in reader:
        if len(normalized) >= 100: raise ValueError("ROW_LIMIT")
        if None in row or any(not isinstance(v, str) or not v.strip() or len(v) > 500 for v in row.values()): raise ValueError("INVALID_ROW")
        if not row["salesOrder"].startswith("PV-DEMO-") or not row["reference"].startswith("REF-DEMO-"): raise ValueError("FIXTURE_REQUIRED")
        quantity = float(row["quantity"])
        if not math.isfinite(quantity) or quantity <= 0: raise ValueError("INVALID_QUANTITY")
        delivery = dt.date.fromisoformat(row["deliveryDate"]).isoformat()
        key = (row["salesOrder"], row["line"])
        if key in seen: raise ValueError("DUPLICATE_LINE")
        seen.add(key)
        normalized.append({"id": row["salesOrder"], "line": row["line"], "client": row["client"], "reference": row["reference"], "quantity": quantity, "deliveryDate": delivery})
    if not normalized: raise ValueError("EMPTY_EXPORT")
    return {"tenant": "g03-rehearsal", "source": source, "sha256": hashlib.sha256(contents.encode()).hexdigest(), "rows": normalized, "writeEnabled": False, "dispatchEnabled": False, "productionCreationEnabled": False, "mappingStatus": "SYNTHETIC_SCHEMA_NOT_PROVIDER_APPROVED"}
