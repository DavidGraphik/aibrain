"""G03 isolated operational rehearsal. Synthetic local data; no provider dispatch.

python3 preparation/server.py --state /tmp/g03-rehearsal --port 8765
Only binds loopback. Credentials are generated once in state/bootstrap.json.
This is an integration candidate, not a production ERP or an AI model runtime.
"""
import argparse
import datetime as dt
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import secrets
import sqlite3
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from readonly_files import ReadOnlyFiles, SourceDenied

TENANT = "g03-rehearsal"
PRINCIPALS = {
    "qa-jordi": {"role": "production-owner", "folders": ["G03", "PLANOLS", "PROJECTES", "QUALITAT", "ADMINISTRACIO"]},
    "qa-lidia": {"role": "production", "folders": ["G03", "PLANOLS", "PROJECTES", "QUALITAT"]},
    "qa-maria": {"role": "administration", "folders": ["G03", "PLANOLS", "PROJECTES", "QUALITAT", "ADMINISTRACIO"]},
    "qa-rosalia": {"role": "receipt-validator", "folders": ["G03", "PLANOLS", "PROJECTES", "QUALITAT"]},
    "qa-victor": {"role": "warehouse", "folders": []},
    "qa-rafa": {"role": "quality-candidate", "folders": ["G03", "PLANOLS", "PROJECTES", "QUALITAT"]},
}
GRANTS = {
    "production-owner": {"orders", "machines", "stock", "warehouse", "quality", "quotes", "purchases", "sales", "maintenance", "tools", "mail", "audit", "outbox", "files"},
    "production": {"orders", "machines", "stock", "warehouse", "maintenance", "tools", "files"},
    "administration": {"orders", "stock", "warehouse", "purchases", "sales", "mail", "outbox", "files"},
    "receipt-validator": {"orders", "stock", "warehouse", "purchases", "files"},
    "warehouse": {"warehouse", "purchases"},
    "quality-candidate": {"quality", "quotes", "mail", "files"},
}
RESOURCES = {"orders", "phases", "machines", "stock", "warehouse", "quality", "quotes", "purchases", "sales", "references", "maintenance", "tools", "mail", "outbox"}
RESOURCE_GRANT = {"phases": "orders", "references": "sales"}
ACTION_ROLES = {
    "order.create": {"production-owner", "production", "administration", "receipt-validator"},
    "order.update": {"production-owner", "production", "administration", "receipt-validator"},
    "phase.create": {"production-owner", "production"},
    "phase.update": {"production-owner", "production"},
    "delivery.record": {"production-owner", "administration", "receipt-validator"},
    "receipt.submit": {"warehouse", "administration", "receipt-validator", "production"},
    "receipt.validate": {"receipt-validator"},
    "stock.adjust": {"administration"},
    "stock.consume": {"administration", "receipt-validator", "production"},
    "quality.create": {"quality-candidate"},
    "quote.calculate": {"quality-candidate"},
    "maintenance.create": {"production-owner", "production"},
    "tool.consume": {"production-owner", "production"},
    "mail.draft": {"quality-candidate", "administration", "production-owner"},
    "sage.import": {"production-owner", "administration"},
}


class Fault(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code


def require(condition, status=400, code="INVALID_INPUT"):
    if not condition:
        raise Fault(status, code)


def quantity(value, zero=False):
    require(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value))
    require(value >= 0 if zero else value > 0)
    return value


def text(value, maximum=500):
    require(isinstance(value, str) and 0 < len(value.strip()) <= maximum)
    return value.strip()


def date(value):
    require(isinstance(value, str))
    try:
        return dt.date.fromisoformat(value).isoformat()
    except ValueError:
        raise Fault(400, "INVALID_DATE")


def utc():
    return dt.datetime.now(dt.timezone.utc).isoformat()


class Store:
    def __init__(self, root):
        self.root = Path(root).resolve()
        require(str(self.root) not in {"/", str(Path.home())}, code="INVALID_STATE_ROOT")
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.root, 0o700)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.root / "operations.sqlite", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS records(kind TEXT, id TEXT, version INTEGER, body TEXT, PRIMARY KEY(kind,id));
          CREATE TABLE IF NOT EXISTS receipts(actor TEXT, request_id TEXT, fingerprint TEXT, response TEXT, PRIMARY KEY(actor,request_id));
          CREATE TABLE IF NOT EXISTS audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT, action TEXT, created TEXT, before_json TEXT, after_json TEXT);
          CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, actor TEXT, expires REAL);
          CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
        """)
        existing = self.db.execute("SELECT value FROM meta WHERE key='tenant'").fetchone()
        require(existing is None or existing[0] == TENANT, 409, "FOREIGN_STATE_ROOT")
        self.db.execute("INSERT OR IGNORE INTO meta VALUES('tenant',?)", (TENANT,))
        self.bootstrap = self.root / "bootstrap.json"
        if self.bootstrap.exists():
            self.credentials = json.loads(self.bootstrap.read_text())
        else:
            self.credentials = {}
            for user in PRINCIPALS:
                password, salt = secrets.token_urlsafe(20), secrets.token_hex(16)
                self.credentials[user] = {"password": password, "salt": salt, "digest": self.digest(password, salt)}
            fd = os.open(self.bootstrap, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, "w") as out:
                json.dump(self.credentials, out)
        self.files = self.root / "fixtures"
        self.files.mkdir(exist_ok=True)
        for folder in {f for p in PRINCIPALS.values() for f in p["folders"]}:
            target = self.files / folder
            target.mkdir(exist_ok=True)
            sample = target / "exemple-sintetic.txt"
            if not sample.exists():
                sample.write_text("DADES SINTÈTIQUES — G03 rehearsal. Cap document del client.\n")
        if not self.db.execute("SELECT id FROM records LIMIT 1").fetchone():
            self.seed()
        self.db.commit()

    @staticmethod
    def digest(password, salt):
        return hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 600_000).hex()

    def seed(self):
        self.put("orders", "OF-DEMO-001", {"client": "Client sintètic A", "reference": "REF-DEMO-1", "salesOrder": "PV-DEMO-1", "units": 100, "unitsDelivered": 0, "deliveryDate": "2026-10-09", "assignedMachine": "M-DEMO-1", "priority": 1, "productionStatus": "PENDENT", "materialStatus": "PENDENT", "materialReference": "MP-DEMO-1", "materialRequired": 100, "materialReceived": 0})
        self.put("machines", "M-DEMO-1", {"name": "Màquina sintètica 1"})
        self.put("phases", "PH-DEMO-1", {"workOrder": "OF-DEMO-001", "machine": "M-DEMO-1", "phase": "TALL", "priority": 2, "status": "PENDENT"})
        self.put("stock", "MP-DEMO-1", {"quantity": 0, "unit": "unitats-demo", "conversion": "UNDEFINED"})
        self.put("purchases", "PC-DEMO-1", {"reference": "MP-DEMO-1", "quantity": 100, "received": 0, "unit": "unitats-demo", "status": "PENDENT"})
        self.put("sales", "PV-DEMO-1", {"client": "Client sintètic A", "reference": "REF-DEMO-1", "quantity": 100, "source": "fixture"})
        self.put("references", "REF-DEMO-1", {"description": "Referència sintètica", "source": "fixture"})
        self.put("mail", "MAIL-DEMO-1", {"subject": "Exemple de consulta", "body": "Correu sintètic, sense destinatari real", "owner": "qa-rafa", "status": "fixture"})

    def put(self, kind, ident, body, version=1):
        self.db.execute("INSERT OR REPLACE INTO records VALUES(?,?,?,?)", (kind, ident, version, json.dumps(body)))
        return {"id": ident, "version": version, **body}

    def get(self, kind, ident):
        row = self.db.execute("SELECT * FROM records WHERE kind=? AND id=?", (kind, ident)).fetchone()
        require(row is not None, 404, "NOT_FOUND")
        return {"id": row["id"], "version": row["version"], **json.loads(row["body"])}

    def list(self, kind):
        return [{"id": r["id"], "version": r["version"], **json.loads(r["body"])} for r in self.db.execute("SELECT * FROM records WHERE kind=? ORDER BY id", (kind,))]

    def change(self, kind, ident, patch):
        old = self.get(kind, ident)
        return self.put(kind, ident, {**{k: v for k, v in old.items() if k not in {"id", "version"}}, **patch}, old["version"] + 1)

    def login(self, user, password):
        require(user in self.credentials and isinstance(password, str), 401, "INVALID_LOGIN")
        entry = self.credentials[user]
        require(hmac.compare_digest(entry["digest"], self.digest(password, entry["salt"])), 401, "INVALID_LOGIN")
        token = secrets.token_urlsafe(32)
        with self.lock, self.db:
            self.db.execute("INSERT INTO sessions VALUES(?,?,?)", (hashlib.sha256(token.encode()).hexdigest(), user, dt.datetime.now().timestamp() + 8 * 3600))
        return token

    def actor(self, token):
        with self.lock:
            row = self.db.execute("SELECT actor,expires FROM sessions WHERE token_hash=?", (hashlib.sha256(token.encode()).hexdigest(),)).fetchone()
        require(row is not None and row[1] > dt.datetime.now().timestamp(), 401, "LOGIN_REQUIRED")
        return row[0]

    def logout(self, token):
        with self.lock, self.db:
            self.db.execute("DELETE FROM sessions WHERE token_hash=?", (hashlib.sha256(token.encode()).hexdigest(),))

    def allowed(self, actor, resource):
        require(RESOURCE_GRANT.get(resource, resource) in GRANTS[PRINCIPALS[actor]["role"]], 403, "PERMISSION_DENIED")

    def read(self, actor, resource):
        self.allowed(actor, resource)
        with self.lock:
            if resource == "audit":
                return [dict(r) for r in self.db.execute("SELECT sequence,actor,action,created FROM audit ORDER BY sequence DESC LIMIT 100")]
            values = self.list(resource)
            if resource == "mail":
                values = [x for x in values if x["owner"] == actor]
            return values

    def file_read(self, actor, relative, listing=False):
        self.allowed(actor, "files")
        reader = ReadOnlyFiles(self.files, TENANT, PRINCIPALS[actor]["folders"])
        if listing:
            return [row for folder in PRINCIPALS[actor]["folders"] for row in reader.list(folder)["rows"]]
        require(isinstance(relative, str) and relative and not relative.startswith("/") and "\\" not in relative, 400, "INVALID_PATH")
        parts = Path(relative).parts
        require(".." not in parts and parts[0] in PRINCIPALS[actor]["folders"], 403, "FOLDER_DENIED")
        current = self.files
        for part in parts:
            current = current / part
            require(not current.is_symlink(), 403, "SYMLINK_DENIED")
        try: return reader.read(relative)
        except SourceDenied as error: raise Fault(403, str(error)) from error

    def act(self, actor, payload):
        require(payload.get("tenant") == TENANT, 403, "TENANT_DENIED")
        action, data = payload.get("action"), payload.get("input", {})
        request_id = text(payload.get("requestId"), 100)
        require(isinstance(data, dict))
        require(action in ACTION_ROLES, 400, "ACTION_UNSUPPORTED")
        require(PRINCIPALS[actor]["role"] in ACTION_ROLES[action], 403, "PERMISSION_DENIED")
        fingerprint = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
        with self.lock, self.db:
            replay = self.db.execute("SELECT fingerprint,response FROM receipts WHERE actor=? AND request_id=?", (actor, request_id)).fetchone()
            if replay:
                require(replay[0] == fingerprint, 409, "REQUEST_ID_CONFLICT")
                return json.loads(replay[1])
            before = None
            ident = "D-" + secrets.token_hex(5)
            if action == "order.create":
                ident = text(data.get("workOrder"), 60)
                require(not self.db.execute("SELECT id FROM records WHERE kind='orders' AND id=?", (ident,)).fetchone(), 409, "ORDER_EXISTS")
                after = self.put("orders", ident, {"client": text(data.get("client")), "reference": text(data.get("reference")), "salesOrder": text(data.get("salesOrder")), "units": quantity(data.get("units")), "unitsDelivered": 0, "deliveryDate": date(data.get("deliveryDate")), "productionStatus": "PENDENT", "materialStatus": "PENDENT", "assignedMachine": None, "priority": 999, "source": "manual-rehearsal"})
            elif action == "order.update":
                ident = text(data.get("id")); before = self.get("orders", ident)
                require(data.get("expectedVersion") == before["version"], 409, "STALE_VERSION")
                patch = data.get("patch", {})
                require(isinstance(patch, dict) and patch)
                allowed = {"deliveryDate", "statusComment", "units"}
                if PRINCIPALS[actor]["role"] in {"production", "production-owner"}:
                    allowed |= {"assignedMachine", "priority", "productionStatus"}
                require(set(patch) <= allowed, 403, "FIELD_DENIED")
                if "units" in patch:
                    quantity(patch["units"]); require(patch["units"] >= before["unitsDelivered"], code="UNITS_BELOW_DELIVERED")
                if "deliveryDate" in patch: date(patch["deliveryDate"])
                if "priority" in patch: quantity(patch["priority"], zero=True)
                if "statusComment" in patch: text(patch["statusComment"])
                if "productionStatus" in patch: require(patch["productionStatus"] in {"PENDENT", "EN CURS", "ATURAT", "ACABAT"})
                if "assignedMachine" in patch: self.get("machines", patch["assignedMachine"])
                after = self.change("orders", ident, patch)
            elif action == "phase.create":
                self.get("orders", text(data.get("workOrder"))); self.get("machines", text(data.get("machine")))
                minutes = data.get("plannedMinutes")
                if minutes is not None: quantity(minutes, zero=True)
                after = self.put("phases", ident, {"workOrder": data["workOrder"], "machine": data["machine"], "phase": text(data.get("phase")), "priority": quantity(data.get("priority"), zero=True), "plannedMinutes": minutes, "status": "PENDENT"})
            elif action == "phase.update":
                ident = text(data.get("id")); before = self.get("phases", ident)
                require(data.get("expectedVersion") == before["version"], 409, "STALE_VERSION")
                patch = data.get("patch")
                require(isinstance(patch, dict) and patch)
                require(set(patch) <= {"machine", "priority", "status", "plannedMinutes"}, 403, "FIELD_DENIED")
                if "machine" in patch: self.get("machines", text(patch["machine"]))
                if "priority" in patch: quantity(patch["priority"], zero=True)
                if "plannedMinutes" in patch: quantity(patch["plannedMinutes"], zero=True)
                if "status" in patch: require(patch["status"] in {"PENDENT", "EN CURS", "ATURAT", "ACABAT"})
                after = self.change("phases", ident, patch)
            elif action == "delivery.record":
                ident = text(data.get("workOrder")); before = self.get("orders", ident)
                amount = quantity(data.get("quantity"))
                require(before["unitsDelivered"] + amount <= before["units"], 409, "OVER_DELIVERY")
                after = self.change("orders", ident, {"unitsDelivered": before["unitsDelivered"] + amount})
            elif action == "receipt.submit":
                purchase = self.get("purchases", text(data.get("purchaseId")))
                amount = quantity(data.get("quantity"))
                require(data.get("unit") == purchase["unit"], 409, "UNIT_MISMATCH")
                require(amount <= purchase["quantity"] - purchase["received"], 409, "OVER_RECEIPT")
                self.get("orders", text(data.get("workOrder")))
                after = self.put("warehouse", ident, {"purchaseId": purchase["id"], "reference": purchase["reference"], "quantity": amount, "unit": purchase["unit"], "workOrder": data["workOrder"], "submittedBy": actor, "status": "PENDING_VALIDATION"})
            elif action == "receipt.validate":
                ident = text(data.get("id")); before = self.get("warehouse", ident)
                require(before["status"] == "PENDING_VALIDATION", 409, "RECEIPT_ALREADY_VALIDATED")
                purchase = self.get("purchases", before["purchaseId"])
                require(purchase["received"] + before["quantity"] <= purchase["quantity"], 409, "OVER_RECEIPT")
                stock = self.get("stock", before["reference"])
                require(stock["unit"] == before["unit"], 409, "UNIT_MISMATCH")
                order = self.get("orders", before["workOrder"])
                require(order.get("materialReference") == before["reference"], 409, "MATERIAL_MAPPING_UNCONFIRMED")
                self.change("stock", stock["id"], {"quantity": stock["quantity"] + before["quantity"]})
                self.change("purchases", purchase["id"], {"received": purchase["received"] + before["quantity"]})
                received = order.get("materialReceived", 0) + before["quantity"]
                self.change("orders", order["id"], {"materialReceived": received, "materialStatus": "REBUT" if received >= order["materialRequired"] else "PARCIAL"})
                after = self.change("warehouse", ident, {"status": "VALIDATED", "validatedBy": actor})
                self.put("outbox", ident, {"provider": "sage", "operation": "purchase_receipt", "sourceId": ident, "status": "BLOCKED_NOT_CONNECTED", "dispatchEnabled": False})
            elif action in {"stock.adjust", "stock.consume"}:
                ident = text(data.get("reference")); before = self.get("stock", ident)
                require(data.get("unit") == before["unit"], 409, "UNIT_MISMATCH")
                quantity_value = quantity(data.get("quantity"), zero=action == "stock.adjust")
                amount = quantity_value if action == "stock.adjust" else before["quantity"] - quantity_value
                require(amount >= 0, 409, "NEGATIVE_STOCK")
                text(data.get("reason"))
                after = self.change("stock", ident, {"quantity": amount, "lastReason": data["reason"]})
            elif action == "quality.create":
                require(data.get("kind") in {"calibration", "nonconformity", "inspection", "iso-review"})
                after = self.put("quality", ident, {"kind": data["kind"], "description": text(data.get("description")), "dueDate": date(data.get("dueDate")), "status": "DRAFT_TEMPLATE_UNVALIDATED", "owner": actor})
            elif action == "quote.calculate":
                lots = data.get("lots")
                require(isinstance(lots, list) and 0 < len(lots) <= 20)
                results = []
                for lot in lots:
                    require(isinstance(lot, dict))
                    units, unit_cost = quantity(lot.get("units")), quantity(lot.get("unitCost"), zero=True)
                    setup = quantity(lot.get("setupCost"), zero=True)
                    results.append({"units": units, "unitCost": unit_cost, "setupCost": setup, "total": round(units * unit_cost + setup, 2)})
                after = self.put("quotes", ident, {"reference": text(data.get("reference")), "lots": results, "currency": "EUR", "status": "SIMULATION_RAFAS_FORMULA_PENDING"})
            elif action == "maintenance.create":
                self.get("machines", text(data.get("machine")))
                after = self.put("maintenance", ident, {"machine": data["machine"], "description": text(data.get("description")), "dueDate": date(data.get("dueDate")), "status": "PLANNED"})
            elif action == "tool.consume":
                self.get("orders", text(data.get("workOrder")))
                after = self.put("tools", ident, {"tool": text(data.get("tool")), "workOrder": data["workOrder"], "quantity": quantity(data.get("quantity")), "status": "RECORDED_REHEARSAL"})
            elif action == "mail.draft":
                source = self.get("mail", text(data.get("messageId")))
                require(source["owner"] == actor, 403, "MAILBOX_DENIED")
                after = self.put("mail", ident, {"subject": source["subject"], "body": text(data.get("body"), 5000), "owner": actor, "status": "DRAFT_ONLY", "sendEnabled": False})
            elif action == "sage.import":
                require(data.get("source") == "synthetic-fixture", 409, "LIVE_SAGE_NOT_CONNECTED")
                rows = data.get("orders")
                require(isinstance(rows, list) and 0 < len(rows) <= 100)
                for row in rows:
                    require(isinstance(row, dict))
                    ident = text(row.get("id"), 60)
                    require(ident.startswith("PV-DEMO-"), code="FIXTURE_ID_REQUIRED")
                    require(text(row.get("reference")).startswith("REF-DEMO-"), code="FIXTURE_ID_REQUIRED")
                    self.put("sales", ident, {"client": text(row.get("client")), "reference": text(row.get("reference")), "quantity": quantity(row.get("quantity")), "source": "synthetic-fixture", "observedAt": utc()})
                    self.put("references", row["reference"], {"description": "Imported synthetic reference", "source": "synthetic-fixture"})
                after = {"imported": len(rows), "source": "synthetic-fixture", "productionCreated": False}
            response = {"tenant": TENANT, "action": action, "record": after, "externalDispatch": False}
            self.db.execute("INSERT INTO audit(actor,action,created,before_json,after_json) VALUES(?,?,?,?,?)", (actor, action, utc(), json.dumps(before), json.dumps(after)))
            self.db.execute("INSERT INTO receipts VALUES(?,?,?,?)", (actor, request_id, fingerprint, json.dumps(response)))
            return response


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, status, body, content_type="application/json", cookie=None):
        data = json.dumps(body, ensure_ascii=False).encode() if content_type == "application/json" else body.encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type + "; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'")
        if cookie: self.send_header("Set-Cookie", cookie)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD": self.wfile.write(data)

    def do_HEAD(self):
        self.do_GET()

    def identity(self):
        token = self.headers.get("Authorization", "").removeprefix("Bearer ")
        if not token:
            cookies = dict(item.strip().split("=", 1) for item in self.headers.get("Cookie", "").split(";") if "=" in item)
            token = cookies.get("g03session", "")
        return self.server.store.actor(token)

    def do_GET(self):
        try:
            require(self.headers.get("Host") == "127.0.0.1:" + str(self.server.server_port), 403, "HOST_DENIED")
            parsed = urlparse(self.path)
            if parsed.path in {"/", "/app.js", "/style.css"}:
                filename = {"/": "index.html", "/app.js": "app.js", "/style.css": "style.css"}[parsed.path]
                content_type = {"/": "text/html", "/app.js": "text/javascript", "/style.css": "text/css"}[parsed.path]
                return self.reply(200, (Path(__file__).parent / "ui" / filename).read_text(), content_type)
            if parsed.path == "/health": return self.reply(200, {"tenant": TENANT, "mode": "synthetic-local", "liveAccepted": False})
            actor = self.identity()
            if parsed.path == "/api/me": return self.reply(200, {"user": actor, **PRINCIPALS[actor], "grants": sorted(GRANTS[PRINCIPALS[actor]["role"]]), "tenant": TENANT})
            if parsed.path == "/api/connections":
                return self.reply(200, {"windows": "FIXTURE_ONLY", "sage": "NOT_CONNECTED", "mail": "FIXTURE_ONLY", "v6": "NOT_AVAILABLE", "aiModel": "NOT_CONNECTED", "dispatchEnabled": False})
            if parsed.path == "/api/files": return self.reply(200, self.server.store.file_read(actor, None, listing=True))
            if parsed.path == "/api/files/read": return self.reply(200, self.server.store.file_read(actor, parse_qs(parsed.query).get("path", [""])[0]))
            resource = parsed.path.removeprefix("/api/")
            require(resource in RESOURCES | {"audit"}, 404, "NOT_FOUND")
            self.reply(200, self.server.store.read(actor, resource))
        except Fault as error: self.reply(error.status, {"error": error.code})

    def do_POST(self):
        try:
            expected = "127.0.0.1:" + str(self.server.server_port)
            require(self.headers.get("Host") == expected, 403, "HOST_DENIED")
            require(self.headers.get("Origin") in {None, "http://" + expected}, 403, "ORIGIN_DENIED")
            length = int(self.headers.get("Content-Length", "0"))
            require(0 < length <= 100_000, 413, "BODY_LIMIT")
            require(self.headers.get("Content-Type", "").split(";")[0] == "application/json", 415, "JSON_REQUIRED")
            raw = self.rfile.read(length)
            payload = json.loads(raw)
            require(isinstance(payload, dict))
            if self.path == "/api/g03/read":
                from bound_bridge import BridgeDenied
                require(getattr(self.server, "bridge", None) is not None, 503, "BRIDGE_NOT_CONFIGURED")
                try: return self.reply(200, self.server.bridge.read(raw, self.headers.get("X-G03-Signature")))
                except (BridgeDenied, OSError, ValueError, KeyError, TypeError): return self.reply(403, {"error": "BOUND_READ_DENIED"})
            if self.path == "/api/login":
                token = self.server.store.login(payload.get("user"), payload.get("password"))
                return self.reply(200, {"authenticated": True, "token": token}, cookie="g03session=" + token + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800")
            if self.path == "/api/logout":
                self.identity()
                cookies = dict(item.strip().split("=", 1) for item in self.headers.get("Cookie", "").split(";") if "=" in item)
                token = self.headers.get("Authorization", "").removeprefix("Bearer ") or cookies.get("g03session", "")
                self.server.store.logout(token)
                return self.reply(200, {"loggedOut": True}, cookie="g03session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0")
            require(self.path == "/api/actions", 404, "NOT_FOUND")
            self.reply(200, self.server.store.act(self.identity(), payload))
        except Fault as error: self.reply(error.status, {"error": error.code})
        except (ValueError, TypeError, KeyError): self.reply(400, {"error": "INVALID_INPUT"})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", required=True)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--bridge-config")
    parser.add_argument("--review-password", help="Public synthetic QA password, local rehearsal only; never use a real password")
    args = parser.parse_args()
    os.umask(0o077)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.store = Store(args.state)
    if args.review_password:
        require(8 <= len(args.review_password) <= 100, code="INVALID_REVIEW_PASSWORD")
        for entry in server.store.credentials.values():
            entry["password"] = args.review_password
            entry["digest"] = Store.digest(args.review_password, entry["salt"])
        server.store.bootstrap.write_text(json.dumps(server.store.credentials))
    if args.bridge_config:
        from bound_bridge import BoundReadBridge
        server.bridge = BoundReadBridge(args.bridge_config, server.store)
    print(json.dumps({"url": "http://127.0.0.1:" + str(server.server_port), "mode": "synthetic-local", "credentialsFile": str(server.store.bootstrap)}), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
