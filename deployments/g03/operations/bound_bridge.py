"""Server-bound read bridge. Purpose-specific signed requests, never admin bearer.

Revalidates durable AiBrain session/user and operator actor config per request.
The only mode currently accepted is synthetic-local; no real ERP fallback.
"""
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import stat
import time
from urllib.parse import urlparse, parse_qs
from brain_bridge import call, TOOLS


class BridgeDenied(ValueError):
    pass


UUID = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$")
HASH = re.compile(r"^[a-f0-9]{64}$")
BINDING_FIELDS = ["userId", "actor", "projectId", "sourceThreadId", "sourceTurnId", "runtimeThreadId", "runtimeTurnId", "requestId"]


def private_read(filename, maximum):
    fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        meta = os.fstat(fd)
        if not stat.S_ISREG(meta.st_mode) or meta.st_nlink != 1 or meta.st_mode & 0o077 or meta.st_size > maximum: raise BridgeDenied("PRIVATE_FILE_REQUIRED")
        data = os.read(fd, maximum + 1)
        if len(data) > maximum: raise BridgeDenied("PRIVATE_FILE_TOO_LARGE")
        return data
    finally: os.close(fd)


class BoundReadBridge:
    def __init__(self, config_path, store):
        self.config_path, self.store = Path(config_path), store
        self.store.db.execute("CREATE TABLE IF NOT EXISTS bridge_requests(request_id TEXT PRIMARY KEY, actor TEXT, created_ms INTEGER)")
        self.store.db.commit()

    def configuration(self):
        config = json.loads(private_read(self.config_path, 32_000))
        if set(config) != {"schemaVersion", "installationId", "mode", "endpoint", "dataRoot", "secretFile", "users"} or config["schemaVersion"] != 1 or config["installationId"] != "g03-rehearsal" or config["mode"] != "synthetic-local": raise BridgeDenied("CONFIG_DENIED")
        root = Path(config["dataRoot"])
        if not root.is_absolute() or root.is_symlink() or root.resolve() == Path(root.anchor): raise BridgeDenied("CONFIG_ROOT_DENIED")
        if not self.config_path.resolve().is_relative_to(root.resolve()) or not Path(config["secretFile"]).resolve().is_relative_to(root.resolve()): raise BridgeDenied("CONFIG_PATH_DENIED")
        endpoint = urlparse(config["endpoint"])
        if endpoint.scheme != "http" or endpoint.hostname != "127.0.0.1" or not endpoint.port or endpoint.path != "/api/g03/read" or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment: raise BridgeDenied("CONFIG_ENDPOINT_DENIED")
        return config

    def read(self, raw, signature):
        config = self.configuration()
        secret = private_read(config["secretFile"], 128).decode().strip()
        if not HASH.fullmatch(secret) or not isinstance(signature, str) or not HASH.fullmatch(signature): raise BridgeDenied("SIGNATURE_DENIED")
        expected = hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, signature): raise BridgeDenied("SIGNATURE_DENIED")
        payload = json.loads(raw)
        fields = {"schemaVersion", "installationId", "sessionIdHash", "operation", "input", "issuedAt", "expiresAt", *BINDING_FIELDS}
        if not isinstance(payload, dict) or set(payload) != fields or payload["schemaVersion"] != 1 or payload["installationId"] != config["installationId"]: raise BridgeDenied("ENVELOPE_DENIED")
        for key in ["userId", "projectId", "sourceThreadId", "sourceTurnId", "requestId"]:
            if not isinstance(payload[key], str) or not UUID.fullmatch(payload[key]): raise BridgeDenied("IDENTITY_DENIED")
        for key in ["runtimeThreadId", "runtimeTurnId"]:
            if not isinstance(payload[key], str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}", payload[key]): raise BridgeDenied("TURN_DENIED")
        now = int(time.time() * 1000)
        if any(not isinstance(payload[k], int) or isinstance(payload[k], bool) for k in ["issuedAt", "expiresAt"]) or payload["issuedAt"] > now + 5000 or payload["expiresAt"] <= now or not 0 < payload["expiresAt"] - payload["issuedAt"] <= 30_000: raise BridgeDenied("ENVELOPE_EXPIRED")
        binding = config["users"].get(payload["userId"])
        if not isinstance(binding, dict) or binding.get("enabled") is not True or binding.get("actor") != payload["actor"]: raise BridgeDenied("ACTOR_REVOKED")
        from server import PRINCIPALS
        if payload["actor"] not in PRINCIPALS: raise BridgeDenied("ACTOR_DENIED")
        root = Path(config["dataRoot"])
        session_hash = payload["sessionIdHash"]
        if not isinstance(session_hash, str) or not HASH.fullmatch(session_hash): raise BridgeDenied("SESSION_DENIED")
        session = json.loads(private_read(root / "sessions" / "records" / (session_hash + ".json"), 16_000))
        user = json.loads(private_read(root / "users" / payload["userId"] / "user.json", 16_000))
        if session.get("sessionIdHash") != session_hash or session.get("installationId") != config["installationId"] or session.get("userId") != payload["userId"] or min(session.get("idleExpiresAt", 0), session.get("absoluteExpiresAt", 0)) <= now or user.get("userId") != payload["userId"] or user.get("enabled") is not True: raise BridgeDenied("SESSION_REVOKED")
        operation = "g03_" + str(payload["operation"])
        definition = next((t for t in TOOLS if t["name"] == operation), None)
        if not definition or not isinstance(payload["input"], dict): raise BridgeDenied("OPERATION_DENIED")
        schema = definition["inputSchema"]
        if not set(payload["input"]) <= set(schema["properties"]) or not set(schema.get("required", [])) <= set(payload["input"]): raise BridgeDenied("INPUT_DENIED")
        def fetch(route):
            parsed = urlparse(route)
            if parsed.path == "/api/connections": return {"windows": "FIXTURE_ONLY", "sage": "NOT_CONNECTED", "mail": "FIXTURE_ONLY", "v6": "NOT_AVAILABLE", "aiModel": "UNVERIFIED", "dispatchEnabled": False}
            if parsed.path == "/api/files": return self.store.file_read(payload["actor"], None, listing=True)
            if parsed.path == "/api/files/read": return self.store.file_read(payload["actor"], parse_qs(parsed.query).get("path", [""])[0])
            return self.store.read(payload["actor"], parsed.path.removeprefix("/api/"))
        with self.store.lock, self.store.db:
            if self.store.db.execute("SELECT request_id FROM bridge_requests WHERE request_id=?", (payload["requestId"],)).fetchone(): raise BridgeDenied("REQUEST_REPLAY_DENIED")
            data = call(operation, payload["input"], fetch)
            self.store.db.execute("INSERT INTO bridge_requests VALUES(?,?,?)", (payload["requestId"], payload["actor"], now))
            self.store.db.execute("INSERT INTO audit(actor,action,created,before_json,after_json) VALUES(?,?,?,?,?)", (payload["actor"], "bridge.read." + payload["operation"], str(now), "null", json.dumps({k: payload[k] for k in BINDING_FIELDS})))
        return {"tenant": config["installationId"], "mode": "synthetic-local", "binding": {k: payload[k] for k in BINDING_FIELDS}, "data": data, "externalDispatch": False}
