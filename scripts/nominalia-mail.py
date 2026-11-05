#!/usr/bin/env python3
"""Bounded Nominalia IMAP/SMTP bridge. One JSON request on stdin, one reply.

Passwords are never accepted through argv/environment, and provider replies are
never surfaced in errors. TLS endpoint names are deliberately not configurable.
"""
import base64
import datetime
import email.policy
import email.utils
from email.message import EmailMessage
from email.parser import BytesParser
import hashlib
import hmac
import imaplib
import json
import os
import quopri
import re
import signal
import smtplib
import socket
import ssl
import sys
import time
from urllib.parse import urlsplit

IMAP_HOST = "pop.securemail.pro"
SMTP_HOST = "authsmtp.securemail.pro"
TIMEOUT = 15
# The parent transport kills this subprocess after 60 seconds. Leave time to
# close a failed socket and return the bounded partial result before that limit.
SEARCH_DEADLINE_SECONDS = 45
MAX_MESSAGE = 8 * 1024 * 1024
MAX_ATTACHMENTS = 5 * 1024 * 1024
MAX_REQUEST = 9 * 1024 * 1024
MAX_TEXT = 150000
MAX_PARTS = 100
MAX_STRUCTURE = 64 * 1024
MAX_STRUCTURE_NODES = 4096
MAX_MIME_DEPTH = 16
MAX_BODY_HEADERS = 32 * 1024
MAX_BODY_PART = 256 * 1024
MAX_BODY_TRANSFER = 512 * 1024
BODY_HEADER_SECTION = "HEADER.FIELDS (FROM TO CC BCC REPLY-TO SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES)"
UID_RE = re.compile(r"^[1-9][0-9]{0,19}$")


class MailError(Exception):
    def __init__(self, code):
        self.code = code


class SearchDeadline(TimeoutError):
    """The whole search budget expired, not an individual socket timeout."""


def fail(code):
    raise MailError(code)


def parse_bodystructure(raw, uid):
    """Parse a bounded FETCH envelope; unsupported literal nstrings fail closed."""
    if not isinstance(raw, bytes) or len(raw) > MAX_STRUCTURE:
        fail("BODY_STRUCTURE_INVALID")
    prefix = re.match(rb"[1-9]\d* +", raw)
    if not prefix:
        fail("BODY_STRUCTURE_INVALID")
    index, nodes = prefix.end(), 0

    def parse(depth=0):
        nonlocal index, nodes
        nodes += 1
        if depth > MAX_MIME_DEPTH or nodes > MAX_STRUCTURE_NODES:
            fail("BODY_STRUCTURE_INVALID")
        while index < len(raw) and raw[index] == 32:
            index += 1
        if index >= len(raw):
            fail("BODY_STRUCTURE_INVALID")
        if raw[index] == 40:
            index += 1
            result = []
            while True:
                while index < len(raw) and raw[index] == 32:
                    index += 1
                if index >= len(raw):
                    fail("BODY_STRUCTURE_INVALID")
                if raw[index] == 41:
                    index += 1
                    return result
                result.append(parse(depth + 1))
        if raw[index] == 34:
            index += 1
            value = bytearray()
            while index < len(raw):
                char = raw[index]
                index += 1
                if char == 34:
                    try:
                        return value.decode("utf-8")
                    except UnicodeError:
                        fail("BODY_STRUCTURE_INVALID")
                if char == 92:
                    if index >= len(raw) or raw[index] not in (34, 92):
                        fail("BODY_STRUCTURE_INVALID")
                    char = raw[index]
                    index += 1
                if char < 32 or char == 127:
                    fail("BODY_STRUCTURE_INVALID")
                value.append(char)
            fail("BODY_STRUCTURE_INVALID")
        match = re.match(rb"[A-Za-z0-9._/-]+", raw[index:])
        if not match:
            fail("BODY_STRUCTURE_INVALID")
        value = match[0]
        index += len(value)
        if value.upper() == b"NIL":
            return None
        if value.isdigit():
            if len(value) > 20:
                fail("BODY_STRUCTURE_INVALID")
            return int(value)
        return value.decode("ascii")

    envelope = parse()
    if raw[index:].strip() or not isinstance(envelope, list) or len(envelope) != 4:
        fail("BODY_STRUCTURE_INVALID")
    fields = {}
    for key, value in zip(envelope[::2], envelope[1::2]):
        if not isinstance(key, str) or key.upper() not in ("UID", "BODYSTRUCTURE") or key.upper() in fields:
            fail("BODY_STRUCTURE_INVALID")
        fields[key.upper()] = value
    if type(fields.get("UID")) is not int or str(fields["UID"]) != uid or not isinstance(fields.get("BODYSTRUCTURE"), list):
        fail("BODY_STRUCTURE_INVALID")
    return fields["BODYSTRUCTURE"]


def bodystructure_parts(structure):
    """Return only validated MIME metadata, with distinct IMAP and legacy IDs."""
    parts, count = [], 0

    def token(value):
        if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9!#$&^_.+-]{1,100}", value):
            fail("BODY_STRUCTURE_INVALID")
        return value.lower()

    def parameters(value):
        if value is None:
            return {}
        if not isinstance(value, list) or len(value) % 2 or len(value) > 100:
            fail("BODY_STRUCTURE_INVALID")
        result = {}
        for key, item in zip(value[::2], value[1::2]):
            if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9!#$&^_.+*-]{1,100}", key) or not isinstance(item, str) or key.lower() in result:
                fail("BODY_STRUCTURE_INVALID")
            result[key.lower()] = item
        return result

    def disposition(value):
        if value is None:
            return None, {}
        if not isinstance(value, list) or len(value) != 2:
            fail("BODY_STRUCTURE_INVALID")
        return token(value[0]), parameters(value[1])

    root_multipart = bool(structure) and isinstance(structure[0], list)

    def walk(node, section=(), inherited_attachment=False, depth=0):
        nonlocal count
        count += 1
        if depth > MAX_MIME_DEPTH or count > MAX_PARTS or not isinstance(node, list) or not node:
            fail("BODY_STRUCTURE_INVALID")
        if isinstance(node[0], list):
            children = 0
            while children < len(node) and isinstance(node[children], list):
                children += 1
            if children == len(node):
                fail("BODY_STRUCTURE_INVALID")
            token(node[children])
            params = parameters(node[children + 1]) if len(node) > children + 1 else {}
            kind, disp = disposition(node[children + 2]) if len(node) > children + 2 else (None, {})
            attached = inherited_attachment or kind == "attachment" or any(k.startswith(("name", "filename")) for k in [*params, *disp])
            for index, child in enumerate(node[:children], 1):
                walk(child, (*section, index), attached, depth + 1)
            return
        if len(node) < 7 or type(node[6]) is not int or not 0 <= node[6] < 10**20:
            fail("BODY_STRUCTURE_INVALID")
        maintype, subtype = token(node[0]), token(node[1])
        if maintype == "multipart":
            fail("BODY_STRUCTURE_INVALID")
        if any(value is not None and not isinstance(value, str) for value in node[3:5]):
            fail("BODY_STRUCTURE_INVALID")
        params = parameters(node[2])
        encoding = token(node[5])
        if maintype == "text" and (len(node) < 8 or type(node[7]) is not int or node[7] < 0):
            fail("BODY_STRUCTURE_INVALID")
        extension = 9 if maintype == "text" else 11 if (maintype, subtype) == ("message", "rfc822") else 8
        if (maintype, subtype) == ("message", "rfc822") and (len(node) < 10 or not isinstance(node[7], list) or not isinstance(node[8], list) or type(node[9]) is not int or node[9] < 0):
            fail("BODY_STRUCTURE_INVALID")
        if len(node) >= extension and node[extension - 1] is not None and not isinstance(node[extension - 1], str):
            fail("BODY_STRUCTURE_INVALID")
        kind, disp = disposition(node[extension]) if len(node) > extension else (None, {})
        mime = EmailMessage()
        mime.set_type(f"{maintype}/{subtype}")
        for key, value in params.items():
            mime.set_param(key, value)
        if kind:
            mime.add_header("Content-Disposition", kind)
            for key, value in disp.items():
                mime.set_param(key, value, header="Content-Disposition")
        filename = mime.get_filename()
        attached = inherited_attachment or kind == "attachment" or filename is not None or any(k.startswith(("name", "filename")) for k in [*params, *disp])
        part_section = ".".join(map(str, section or (1,)))
        parts.append({"section": part_section, "partId": f"1.{part_section}" if root_multipart else "1",
                      "contentType": f"{maintype}/{subtype}", "encodedSize": node[6], "encoding": encoding,
                      "charset": mime.get_content_charset() or "utf-8", "filename": str(filename or "attachment")[:500],
                      "body": not attached and maintype == "text" and subtype in ("plain", "html")})

    walk(structure)
    return parts


def text(value, maximum=1000, empty=False):
    if not isinstance(value, str) or len(value) > maximum or (not empty and not value):
        fail("INVALID_INPUT")
    if any(c in value for c in ("\r", "\n", "\x00")):
        fail("INVALID_INPUT")
    return value


def address(value):
    value = text(value, 254)
    if not re.fullmatch(r"[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+", value):
        fail("INVALID_INPUT")
    return value


def quote(value):
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def encode_folder(name):
    name = text(name, 500)
    chunks = []
    pending = []
    def flush():
        if pending:
            chunks.append("&" + base64.b64encode("".join(pending).encode("utf-16-be")).decode().rstrip("=").replace("/", ",") + "-")
            pending.clear()
    for c in name:
        if " " <= c <= "~":
            flush()
            chunks.append("&-" if c == "&" else c)
        else:
            pending.append(c)
    flush()
    return "".join(chunks)


def decode_folder(name):
    def replace(match):
        value = match.group(1)
        if not value:
            return "&"
        return base64.b64decode(value.replace(",", "/") + "=" * (-len(value) % 4)).decode("utf-16-be")
    try:
        return re.sub(r"&([^-]*)-", replace, name)
    except (ValueError, UnicodeError):
        fail("PROVIDER_RESPONSE_INVALID")


def connect_socket(host, port):
    proxy_url = os.environ.get("AIBRAIN_EGRESS_PROXY_URL")
    raw = None
    try:
        if proxy_url:
            proxy = urlsplit(proxy_url)
            token = os.environ.get("AIBRAIN_EGRESS_SERVER_TOKEN", "")
            if proxy.scheme != "http" or not proxy.hostname or proxy.username or proxy.password or proxy.path not in ("", "/") or proxy.query or proxy.fragment or not token or any(c in token for c in "\r\n\x00"):
                fail("PROXY_CONFIGURATION_INVALID")
            raw = socket.create_connection((proxy.hostname, proxy.port or 80), TIMEOUT)
            auth = base64.b64encode(("aibrain:" + token).encode()).decode()
            raw.sendall((f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\nProxy-Authorization: Basic {auth}\r\n\r\n").encode("ascii"))
            response = bytearray()
            while not response.endswith(b"\r\n\r\n"):
                block = raw.recv(1)
                if not block or len(response) >= 16384:
                    fail("PROXY_CONNECTION_FAILED")
                response.extend(block)
            if not re.match(rb"HTTP/1\.[01] 200(?: |\r)", response):
                fail("PROXY_CONNECTION_FAILED")
        else:
            raw = socket.create_connection((host, port), TIMEOUT)
        return raw
    except BaseException:
        if raw is not None:
            raw.close()
        raise


class NominaliaIMAP(imaplib.IMAP4_SSL):
    def _create_socket(self, timeout):
        raw = connect_socket(IMAP_HOST, 993)
        try:
            return ssl.create_default_context().wrap_socket(raw, server_hostname=IMAP_HOST)
        except BaseException:
            raw.close()
            raise

    def read(self, size):
        limit = getattr(self, "literal_limit", MAX_MESSAGE)
        if type(size) is not int or size < 0 or type(limit) is not int or not 0 < limit <= MAX_MESSAGE:
            fail("PROVIDER_RESPONSE_INVALID")
        if size > limit:
            fail("MESSAGE_TOO_LARGE")
        return super().read(size)


class NominaliaSMTP(smtplib.SMTP):
    def _get_socket(self, host, port, timeout):
        return connect_socket(SMTP_HOST, 587)


def ok_response(response):
    if response[0] != "OK":
        fail("PROVIDER_OPERATION_FAILED")
    return response[1]


class Mailbox:
    def __init__(self, credentials):
        if not isinstance(credentials, dict):
            fail("INVALID_INPUT")
        self.email = address(credentials.get("email"))
        self.password = credentials.get("password")
        if not isinstance(self.password, str) or not self.password or len(self.password) > 4096 or "\x00" in self.password or "\r" in self.password or "\n" in self.password:
            fail("INVALID_INPUT")
        self.cursor_secret = credentials.get("cursorSecret")
        if self.cursor_secret is not None and (not isinstance(self.cursor_secret, str) or not re.fullmatch(r"[a-f0-9]{64}", self.cursor_secret)):
            fail("INVALID_INPUT")
        self.imap = None
        self.search_phase = "arguments"

    def login(self):
        if self.imap is None:
            self.imap = NominaliaIMAP(IMAP_HOST, 993, timeout=TIMEOUT)
            try:
                ok_response(self.imap.login(self.email, self.password))
            except imaplib.IMAP4.error:
                fail("AUTH_FAILED")
        return self.imap

    def smtp(self):
        client = NominaliaSMTP(SMTP_HOST, 587, timeout=TIMEOUT)
        try:
            client.ehlo()
            if not client.has_extn("starttls"):
                fail("TLS_REQUIRED")
            client.starttls(context=ssl.create_default_context())
            client.ehlo()
            client.login(self.email, self.password)
            return client
        except BaseException:
            client.close()
            raise

    def close(self):
        if self.imap:
            try:
                self.imap.logout()
            except Exception:
                pass

    def select(self, folder, writable=False):
        imap = self.login()
        ok_response(imap.select(quote(encode_folder(folder)), readonly=not writable))
        _, values = imap.response("UIDVALIDITY")
        validity = values[0].decode("ascii") if values and isinstance(values[0], bytes) else ""
        if not UID_RE.fullmatch(validity):
            fail("PROVIDER_RESPONSE_INVALID")
        return validity

    def reference(self, args, writable=False):
        ref = args.get("message")
        if not isinstance(ref, dict):
            fail("INVALID_INPUT")
        folder = text(ref.get("folder"), 500)
        uid = str(ref.get("uid", ""))
        validity = str(ref.get("uidValidity", ""))
        if not UID_RE.fullmatch(uid) or not UID_RE.fullmatch(validity):
            fail("INVALID_INPUT")
        if self.select(folder, writable) != validity:
            fail("STALE_MESSAGE_REF")
        return folder, uid, validity

    def folders(self):
        rows = ok_response(self.login().list())
        result = []
        for row in rows[:500]:
            if not isinstance(row, bytes):
                continue
            match = re.fullmatch(rb'\(([^)]*)\) (?:NIL|"(?:[^"\\]|\\.)*") (.+)', row)
            if not match:
                fail("PROVIDER_RESPONSE_INVALID")
            name = match[2].decode("ascii")
            if name.startswith('"') and name.endswith('"'):
                name = re.sub(r"\\(.)", r"\1", name[1:-1])
            result.append({"name": decode_folder(name), "attributes": match[1].decode("ascii").split()})
        return {"folders": result, "truncated": len(rows) > 500}

    def special_folder(self, kind):
        folders = self.folders()["folders"]
        special = "\\Drafts" if kind == "draft" else "\\Sent"
        for row in folders:
            if special.lower() in [attr.lower() for attr in row["attributes"]]:
                return row["name"]
        names = ("Drafts", "INBOX.Drafts", "Bozze", "Borradores", "Esborranys") if kind == "draft" else ("Sent", "Sent Items", "INBOX.Sent", "Posta inviata", "Enviados", "Enviats")
        for name in names:
            if any(row["name"].lower() == name.lower() for row in folders):
                return next(row["name"] for row in folders if row["name"].lower() == name.lower())
        fail("DRAFT_FOLDER_NOT_FOUND" if kind == "draft" else "SENT_FOLDER_NOT_FOUND")

    def fetch_metadata(self, uid, require_flags=False):
        # Check RFC822.SIZE before allowing imaplib to consume a message literal.
        rows = ok_response(self.imap.uid("FETCH", uid, "(UID RFC822.SIZE FLAGS)"))
        metadata = b" ".join(row for row in rows if isinstance(row, bytes))
        match = re.search(rb"\bRFC822\.SIZE (\d+)", metadata)
        found_uid = re.search(rb"\bUID (\d+)", metadata)
        if not match or not found_uid or found_uid[1].decode() != uid:
            fail("MESSAGE_NOT_FOUND")
        flags_match = re.search(rb"FLAGS \(([^)]*)\)", metadata)
        if require_flags and flags_match is None:
            fail("PROVIDER_RESPONSE_INVALID")
        return (flags_match[1].split() if flags_match else []), int(match[1])

    def fetch(self, uid, content=False, metadata=None):
        flags, size = metadata if metadata is not None else self.fetch_metadata(uid)
        if content and size > MAX_MESSAGE:
            fail("MESSAGE_TOO_LARGE")
        target = "BODY.PEEK[]" if content else "BODY.PEEK[HEADER.FIELDS (FROM TO CC BCC REPLY-TO SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES)]"
        rows = ok_response(self.imap.uid("FETCH", uid, f"(UID {target})"))
        literals = [row[1] for row in rows if isinstance(row, tuple) and isinstance(row[1], bytes)]
        if len(literals) != 1 or len(literals[0]) > MAX_MESSAGE:
            fail("PROVIDER_RESPONSE_INVALID")
        self.last_raw = literals[0]
        message = BytesParser(policy=email.policy.default).parsebytes(literals[0])
        return message, flags, size

    def bounded_section(self, uid, section, limit):
        """Every partial literal is bounded before imaplib consumes its bytes."""
        if not 0 < limit <= max(MAX_BODY_PART, MAX_BODY_HEADERS) or not (section == BODY_HEADER_SECTION or re.fullmatch(r"[1-9]\d*(?:\.[1-9]\d*){0,15}", section)):
            fail("PROVIDER_RESPONSE_INVALID")
        previous = getattr(self.imap, "literal_limit", MAX_MESSAGE)
        self.imap.literal_limit = limit
        try:
            rows = ok_response(self.imap.uid("FETCH", uid, f"(UID BODY.PEEK[{section}]<0.{limit}>)"))
        finally:
            self.imap.literal_limit = previous
        if not isinstance(rows, list) or any(not isinstance(row, (tuple, bytes)) for row in rows):
            fail("PROVIDER_RESPONSE_INVALID")
        literals = [row for row in rows if isinstance(row, tuple)]
        if len(literals) != 1 or len(literals[0]) != 2 or not isinstance(literals[0][0], bytes) or not isinstance(literals[0][1], bytes):
            fail("PROVIDER_RESPONSE_INVALID")
        data = literals[0][1]
        metadata = b" ".join(row[0] if isinstance(row, tuple) else row for row in rows)
        identities = re.findall(rb"\bUID (\d+)", metadata)
        selected = re.findall(rb"\bBODY\[" + re.escape(section.encode("ascii")) + rb"\]<0> \{(\d+)\}", metadata, re.I)
        if len(metadata) > MAX_STRUCTURE or identities != [uid.encode()] or selected != [str(len(data)).encode()] or len(data) > limit:
            fail("PROVIDER_RESPONSE_INVALID")
        return data

    def read_large_body(self, folder, uid, validity, flags, size):
        # This is only a display read. Full draft fingerprints and attachment
        # downloads still use the unchanged complete-message size guards.
        if any(flag.lower() == b"\\draft" for flag in flags) or size <= MAX_MESSAGE:
            fail("MESSAGE_TOO_LARGE")
        previous = getattr(self.imap, "literal_limit", MAX_MESSAGE)
        self.imap.literal_limit = MAX_STRUCTURE
        try:
            rows = ok_response(self.imap.uid("FETCH", uid, "(UID BODYSTRUCTURE)"))
        finally:
            self.imap.literal_limit = previous
        if not isinstance(rows, list) or not rows or any(not isinstance(row, bytes) for row in rows):
            fail("BODY_STRUCTURE_INVALID")
        parts = bodystructure_parts(parse_bodystructure(b" ".join(rows), uid))
        eligible = [part for part in parts if part["body"]]
        if not eligible:
            fail("MESSAGE_BODY_UNAVAILABLE")
        if any(part["encoding"] not in ("7bit", "8bit", "binary", "base64", "quoted-printable") for part in eligible):
            fail("BODY_PART_ENCODING_UNSUPPORTED")
        raw_headers = self.bounded_section(uid, BODY_HEADER_SECTION, MAX_BODY_HEADERS)
        if len(raw_headers) == MAX_BODY_HEADERS:
            fail("MESSAGE_HEADERS_TOO_LARGE")
        message = BytesParser(policy=email.policy.default).parsebytes(raw_headers)
        result = self.message_view(message, flags, folder, uid, validity, size)
        plain, html, warnings, fetched = [], [], [], []
        transferred, total_text, truncated = 0, 0, False
        for part in eligible:
            if transferred >= MAX_BODY_TRANSFER or total_text >= MAX_TEXT:
                truncated = True
                continue
            limit = min(MAX_BODY_PART, MAX_BODY_TRANSFER - transferred, part["encodedSize"]) if part["encodedSize"] else 0
            data = self.bounded_section(uid, part["section"], limit) if part["encodedSize"] else b""
            if len(data) != min(part["encodedSize"], limit):
                fail("PROVIDER_RESPONSE_INVALID")
            partial = part["encodedSize"] > len(data)
            transferred += len(data)
            if part["encoding"] == "base64":
                encoded = re.sub(rb"[ \r\n\t]", b"", data)
                if partial:
                    encoded = encoded[:len(encoded) // 4 * 4]
                try:
                    decoded = base64.b64decode(encoded, validate=True)
                except ValueError:
                    fail("BODY_PART_ENCODING_INVALID")
            elif part["encoding"] == "quoted-printable":
                if partial:
                    data = re.sub(rb"=(?:[A-Fa-f0-9])?$", b"", data)
                decoded = quopri.decodestring(data)
            else:
                decoded = data
            try:
                value = decoded.decode(part["charset"], errors="replace")
            except (LookupError, UnicodeError):
                value = decoded.decode("utf-8", errors="replace")
                warnings.append("unknown_charset_replaced_with_utf8")
            target = plain if part["contentType"] == "text/plain" else html
            separator = 1 if target else 0
            remaining = max(0, MAX_TEXT - total_text - separator)
            if remaining:
                target.append(value[:remaining])
                total_text += separator + min(len(value), remaining)
            truncated = truncated or partial or len(value) > remaining
            fetched.append(part["section"])
        attachments = [{"partId": part["partId"], "section": part["section"], "filename": part["filename"],
                        "contentType": part["contentType"], "size": None, "encodedSize": part["encodedSize"],
                        "sizeSource": "bodystructure_encoded", "contentOmitted": True} for part in parts if not part["body"]]
        result.update(text="\n".join(plain), html="\n".join(html), attachments=attachments,
                      readMode="bounded_text_parts", messageTruncated=True, bodyTruncated=truncated,
                      attachmentContentsOmitted=True, fingerprintUnavailableReason="partial_message",
                      bodyDecodingWarnings=sorted(set(warnings)),
                      bodyCoverage={"eligibleParts": len(eligible), "readSections": fetched, "complete": not truncated,
                                    "encodedBytesFetched": transferred, "maximumEncodedBytes": MAX_BODY_TRANSFER})
        return result

    def message_view(self, message, flags, folder, uid, validity, size, content=False):
        def header(name):
            return str(message.get(name, ""))
        result = {"folder": folder, "uid": uid, "uidValidity": validity,
                  "subject": header("Subject"), "from": header("From"), "to": header("To"), "cc": header("Cc"),
                  "date": header("Date"), "messageId": header("Message-ID"), "size": size,
                  "replyTo": header("Reply-To"), "inReplyTo": header("In-Reply-To"), "references": header("References"),
                  "bcc": header("Bcc") if b"\\Draft" in flags else "", "isDraft": b"\\Draft" in flags,
                  "unread": b"\\Seen" not in flags, "flagged": b"\\Flagged" in flags}
        if content:
            result["fingerprint"] = hashlib.sha256(self.last_raw).hexdigest()
            plain, html, attachments = [], [], []
            total_text = 0
            for part_id, part in iter_parts(message):
                if part.get_content_maintype() == "multipart":
                    continue
                payload = part_bytes(part)
                filename = part.get_filename()
                if filename or part.get_content_disposition() == "attachment" or part.get_content_maintype() != "text":
                    attachments.append({"partId": part_id, "filename": str(filename or "attachment")[:500], "contentType": part.get_content_type(), "size": len(payload)})
                elif part.get_content_type() in ("text/plain", "text/html"):
                    try:
                        value = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
                    except LookupError:
                        value = payload.decode("utf-8", errors="replace")
                    remaining = MAX_TEXT - total_text
                    if remaining > 0:
                        (plain if part.get_content_type() == "text/plain" else html).append(value[:remaining])
                        total_text += min(len(value), remaining)
            result.update(text="\n".join(plain), html="\n".join(html), attachments=attachments, bodyTruncated=total_text >= MAX_TEXT)
        return result

    def search_cursor_key(self):
        if self.cursor_secret is None:
            fail("CURSOR_KEY_NOT_CONFIGURED")
        return bytes.fromhex(self.cursor_secret)

    def list_messages(self, args):
        folder = text(args["folder"], 500) if args.get("folder") else None
        limit = args.get("limit", 20)
        if type(limit) is not int or not 1 <= limit <= 50:
            fail("INVALID_INPUT")
        query = args.get("query", {})
        if not isinstance(query, dict) or set(query) - {"text", "from", "to", "participant", "subject", "since", "before", "unread"}:
            fail("INVALID_INPUT")
        criteria = []
        for key in ("text", "from", "to", "subject"):
            if key in query:
                criteria.extend([key.upper(), quote(text(query[key], 500))])
        if "participant" in query:
            participant = quote(text(query["participant"], 500))
            criteria.extend(["OR", "FROM", participant, "OR", "TO", participant, "CC", participant])
        for key in ("since", "before"):
            if key in query:
                try:
                    date = datetime.date.fromisoformat(text(query[key], 10))
                except ValueError:
                    fail("INVALID_INPUT")
                months = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
                criteria.extend([key.upper(), f"{date.day:02d}-{months[date.month - 1]}-{date.year}"])
        if "unread" in query:
            if type(query["unread"]) is not bool:
                fail("INVALID_INPUT")
            criteria.append("UNSEEN" if query["unread"] else "SEEN")
        # A cursor fixes each folder's UID ceiling and UIDVALIDITY. New mail
        # cannot shift a later page or cause repeated results across pages.
        scope = hashlib.sha256(json.dumps({"email": self.email.lower(), "folder": folder, "query": query}, sort_keys=True).encode()).hexdigest()
        cursor = args.get("cursor")
        if cursor:
            try:
                if not isinstance(cursor, str) or len(cursor) > 100000:
                    fail("INVALID_CURSOR")
                encoded_state, signature = cursor.rsplit(".", 1)
                key = self.search_cursor_key()
                expected = hmac.new(key, encoded_state.encode(), hashlib.sha256).hexdigest()
                if not hmac.compare_digest(signature, expected):
                    fail("INVALID_CURSOR")
                state = json.loads(base64.urlsafe_b64decode(encoded_state.encode()).decode())
                if not isinstance(state, dict):
                    fail("INVALID_CURSOR")
                if state.get("scope") != scope or state.get("version") != 1:
                    fail("INVALID_CURSOR")
                skipped_count = state.get("skippedCount", 0)
                if type(skipped_count) is not int or skipped_count < 0:
                    fail("INVALID_CURSOR")
                snapshot = state["snapshot"]
                pending = state["pending"]
                if not isinstance(pending, list) or len(pending) > 500 or not isinstance(snapshot, list) or len(snapshot) > 500:
                    fail("INVALID_CURSOR")
                for row in pending + snapshot:
                    if not isinstance(row, dict):
                        fail("INVALID_CURSOR")
                    text(row["folder"], 500)
                    if not UID_RE.fullmatch(row["validity"]) or type(row["before"]) is not int or not 0 <= row["before"] <= 10**20:
                        fail("INVALID_CURSOR")
            except (ValueError, TypeError, KeyError, UnicodeError):
                fail("INVALID_CURSOR")
        else:
            self.search_phase = "folders_list"
            listing = self.folders() if folder is None else {"folders": [{"name": folder, "attributes": []}], "truncated": False}
            if listing["truncated"]:
                fail("FOLDER_LIST_INCOMPLETE")
            pending = []
            skipped_count = 0
            for row in listing["folders"]:
                if "\\noselect" in [attr.lower() for attr in row["attributes"]]:
                    continue
                self.search_phase = "snapshot_select"
                validity = self.select(row["name"])
                # SELECT's UIDNEXT fixes the exclusive ceiling without running
                # an expensive TEXT search in every folder before page one.
                # Query results are evaluated lazily below against that ceiling.
                self.search_phase = "snapshot_uidnext"
                _, values = self.imap.response("UIDNEXT")
                if not isinstance(values, list) or len(values) != 1 or not isinstance(values[0], bytes):
                    fail("PROVIDER_RESPONSE_INVALID")
                try:
                    next_uid = values[0].decode("ascii")
                except UnicodeError:
                    fail("PROVIDER_RESPONSE_INVALID")
                if not UID_RE.fullmatch(next_uid):
                    fail("PROVIDER_RESPONSE_INVALID")
                pending.append({"folder": row["name"], "validity": validity, "before": int(next_uid)})
            snapshot = [dict(row) for row in pending]
        messages, skipped, searched = [], [], []
        interrupted = None
        def stop_partial(reason, current):
            nonlocal interrupted
            interrupted = {"reason": reason, "folder": current, "retryable": True}
            if self.imap:
                try:
                    self.imap.shutdown()
                except Exception:
                    pass
            self.imap = None
        while pending and len(messages) + len(skipped) < limit:
            row = pending[0]
            current = row["folder"]
            self.search_phase = "page_select"
            try:
                validity = self.select(current)
            except SearchDeadline:
                stop_partial("search_deadline", current)
                break
            if validity != row["validity"]:
                fail("STALE_SEARCH_CURSOR")
            self.search_phase = "page_search"
            try:
                ids = [uid for uid in self.search_ids(criteria, row["before"]) if uid < row["before"]]
            except TimeoutError as first_error:
                # A timed-out socket is unusable. Reconnect once, reselect the
                # same folder and check UIDVALIDITY before the identical search.
                try:
                    self.imap.shutdown()
                except SearchDeadline as deadline:
                    first_error = deadline
                except Exception:
                    pass
                self.imap = None
                try:
                    if isinstance(first_error, SearchDeadline):
                        raise first_error
                    self.search_phase = "page_select"
                    if self.select(current) != row["validity"]:
                        fail("STALE_SEARCH_CURSOR")
                    self.search_phase = "page_search"
                    ids = [uid for uid in self.search_ids(criteria, row["before"]) if uid < row["before"]]
                except (OSError, imaplib.IMAP4.abort) as retry_error:
                    # Preserve earlier results and the unsearched folder's UID
                    # ceiling; do not retry again or mark its coverage complete.
                    stop_partial("search_deadline" if isinstance(retry_error, SearchDeadline) else "provider_search_timeout" if isinstance(retry_error, TimeoutError) else "provider_search_unavailable", current)
                    break
            searched.append(current)
            if not ids:
                pending.pop(0)
                continue
            take = sorted(ids, reverse=True)[:limit - len(messages) - len(skipped)]
            for number in take:
                uid = str(number)
                try:
                    self.search_phase = "page_fetch"
                    message, flags, size = self.fetch(uid)
                    messages.append(self.message_view(message, flags, current, uid, validity, size))
                except SearchDeadline:
                    # The interrupted UID remains eligible on continuation.
                    stop_partial("search_deadline", current)
                    break
                except MailError as exc:
                    if exc.code not in ("MESSAGE_NOT_FOUND", "MESSAGE_TOO_LARGE"):
                        raise
                    skipped.append({"folder": current, "uid": uid, "code": exc.code})
                row["before"] = number
            if interrupted:
                break
            if len(take) == len(ids):
                pending.pop(0)
        skipped_count += len(skipped)
        # Completed folders are a prefix of the immutable snapshot; include the
        # current page's partially consumed folder without claiming that queued
        # folders have already had their query evaluated.
        searched_folders = [row["folder"] for row in snapshot[:len(snapshot) - len(pending)]]
        searched_folders.extend(current for current in searched if current not in searched_folders)
        next_cursor = None
        if pending:
            encoded_state = base64.urlsafe_b64encode(json.dumps({"version": 1, "scope": scope, "pending": pending, "snapshot": snapshot, "skippedCount": skipped_count}, separators=(",", ":")).encode()).decode()
            key = self.search_cursor_key()
            next_cursor = encoded_state + "." + hmac.new(key, encoded_state.encode(), hashlib.sha256).hexdigest()
            if len(next_cursor) > 100000:
                fail("SEARCH_SCOPE_TOO_LARGE")
        result = {"messages": messages, "truncated": bool(pending), "nextCursor": next_cursor,
                  "coverage": {"source": "server_imap_only", "scope": "folder" if folder else "all_selectable_server_folders", "searchedFolders": searched_folders, "pageFolders": searched,
                               "order": "folder_then_descending_uid", "snapshotBounds": snapshot,
                               "newMailExcluded": True, "queryMatchesEvaluatedAtEachPage": True,
                               "complete": not pending and not skipped_count, "skipped": skipped, "skippedCount": skipped_count}}
        if interrupted:
            result["coverage"]["interrupted"] = interrupted
            result["coverageInstruction"] = ("Search stopped before this folder was fully processed because the provider was unavailable or the search deadline expired. "
                "Results and coverage are partial; do not claim an exhaustive search or automatically retry in a loop. "
                "A later explicit request may resume with nextCursor, or search a narrower scope.")
        if folder:
            result["folder"] = folder
        return result

    def search_ids(self, criteria, before=None):
        values = list(criteria or ["ALL"])
        if before is not None:
            if before <= 1:
                return []
            values.extend(["UID", f"1:{before - 1}"])
        encoded = [value.encode("utf-8") for value in values]
        rows = ok_response(self.imap.uid("SEARCH", "CHARSET", "UTF-8", *encoded))
        ids = b" ".join(row for row in rows if isinstance(row, bytes)).split()
        if any(not UID_RE.fullmatch(uid.decode("ascii")) for uid in ids):
            fail("PROVIDER_RESPONSE_INVALID")
        return [int(uid) for uid in ids]

    def read(self, args, attachment=False):
        folder, uid, validity = self.reference(args)
        metadata = self.fetch_metadata(uid, require_flags=True)
        flags, size = metadata
        if not attachment and size > MAX_MESSAGE and not any(flag.lower() == b"\\draft" for flag in flags):
            return self.read_large_body(folder, uid, validity, flags, size)
        message, flags, size = self.fetch(uid, content=True, metadata=metadata)
        if attachment:
            part_id = text(args.get("partId"), 100)
            for ident, part in iter_parts(message):
                if ident == part_id and part.get_content_maintype() != "multipart":
                    data = part_bytes(part)
                    if len(data) > MAX_ATTACHMENTS:
                        fail("ATTACHMENT_TOO_LARGE")
                    return {"partId": ident, "filename": str(part.get_filename() or "attachment")[:500], "contentType": part.get_content_type(), "size": len(data), "dataBase64": base64.b64encode(data).decode()}
            fail("ATTACHMENT_NOT_FOUND")
        return self.message_view(message, flags, folder, uid, validity, size, content=True)

    def addresses(self, message, header):
        result = []
        for _, value in email.utils.getaddresses([str(v) for v in message.get_all(header, [])]):
            if value:
                value = address(value)
                if value.lower() not in [item.lower() for item in result]:
                    result.append(value)
        return result

    def reply(self, args):
        folder, uid, validity = self.reference(args)
        message, _, _ = self.fetch(uid)
        if type(args.get("replyAll", False)) is not bool:
            fail("INVALID_INPUT")
        own = self.email.lower()
        sender = self.addresses(message, "Reply-To") or self.addresses(message, "From")
        to = [value for value in sender if value.lower() != own]
        # Replying to our own sent message follows its original recipients.
        if not to:
            to = [value for value in self.addresses(message, "To") if value.lower() != own]
        cc = []
        if args.get("replyAll"):
            for value in self.addresses(message, "To") + self.addresses(message, "Cc"):
                if value.lower() != own and value.lower() not in [item.lower() for item in to + cc]:
                    cc.append(value)
        if not to:
            fail("REPLY_RECIPIENT_NOT_FOUND")
        if any(len(message.get_all(header, [])) > 1 for header in ("Message-ID", "References", "In-Reply-To", "Reply-To", "From")):
            fail("THREAD_HEADERS_INVALID")
        parent_header = message.get("Message-ID", "")
        if getattr(parent_header, "defects", ()):
            fail("THREAD_HEADERS_INVALID")
        parent = str(parent_header).strip()
        if not re.fullmatch(r"<[^\s<>@]+@[^\s<>@]+>", parent):
            fail("THREAD_HEADERS_INVALID")
        references = str(message.get("References", "")) or str(message.get("In-Reply-To", ""))
        refs = re.findall(r"<[^\s<>@]+@[^\s<>@]+>", references)
        if references and re.sub(r"<[^\s<>@]+@[^\s<>@]+>", "", references).strip():
            fail("THREAD_HEADERS_INVALID")
        if parent not in refs:
            refs.append(parent)
        chain = " ".join(refs)
        if len(chain) > 2000:
            fail("THREAD_HEADERS_TOO_LARGE")
        subject = str(message.get("Subject", ""))
        if not re.match(r"(?i)^re\s*:", subject):
            subject = "Re: " + subject
        text(subject, 1000, empty=True)
        body = args.get("text", "")
        if not isinstance(body, str) or len(body) > MAX_TEXT or "\x00" in body:
            fail("INVALID_INPUT")
        return {"payload": {"to": to, "cc": cc, "bcc": [], "subject": subject, "text": body,
                            "inReplyTo": parent, "references": chain, "attachments": []},
                "source": {"folder": folder, "uid": uid, "uidValidity": validity}}

    def draft_payload(self, message, view):
        if view["bodyTruncated"]:
            fail("DRAFT_CONTENT_TRUNCATED")
        # Arbitrary HTML and signed/encrypted drafts cannot safely be recomposed
        # as plain text. Never silently drop those parts during edit/send.
        if view["html"] or message.get_content_type() not in ("text/plain", "multipart/mixed"):
            fail("DRAFT_FORMAT_UNSUPPORTED")
        attachments = []
        total = 0
        for ident, part in iter_parts(message):
            if part.get_content_maintype() == "multipart":
                continue
            if part.get_filename() or part.get_content_disposition() == "attachment" or part.get_content_maintype() != "text":
                data = part_bytes(part)
                total += len(data)
                attachments.append({"filename": str(part.get_filename() or "attachment"), "contentType": part.get_content_type(), "dataBase64": base64.b64encode(data).decode()})
            elif part.get_content_type() != "text/plain":
                fail("DRAFT_FORMAT_UNSUPPORTED")
        if total > MAX_ATTACHMENTS or len(attachments) > 10:
            fail("ATTACHMENT_TOO_LARGE")
        result = {"to": self.addresses(message, "To"), "cc": self.addresses(message, "Cc"), "bcc": self.addresses(message, "Bcc"),
                  "subject": view["subject"], "text": view["text"], "attachments": attachments}
        for key in ("inReplyTo", "references"):
            if view[key]:
                result[key] = view[key]
        return result

    def validate_draft(self, ref, writable=False):
        if not isinstance(ref, dict) or not re.fullmatch(r"[a-f0-9]{64}", str(ref.get("fingerprint", ""))):
            fail("INVALID_INPUT")
        draft_folder = self.special_folder("draft")
        if ref.get("folder") != draft_folder:
            fail("NOT_A_DRAFT")
        folder, uid, validity = self.reference({"message": ref}, writable=writable)
        message, flags, size = self.fetch(uid, content=True)
        if b"\\Draft" not in flags:
            fail("NOT_A_DRAFT")
        if hashlib.sha256(self.last_raw).hexdigest() != ref["fingerprint"]:
            fail("STALE_DRAFT_FINGERPRINT")
        return message, self.message_view(message, flags, folder, uid, validity, size, content=True)

    def draft_payload_operation(self, args):
        message, view = self.validate_draft(args.get("draft"))
        return self.draft_payload(message, view)

    def authenticated_capabilities(self):
        # imaplib caches the greeting's pre-authentication capabilities. Some
        # providers advertise MOVE/UIDPLUS only after LOGIN. Query the current
        # session before choosing any operation that can remove a message.
        rows = ok_response(self.login().capability())
        if not isinstance(rows, list) or not rows or any(not isinstance(row, bytes) or not row for row in rows):
            fail("PROVIDER_RESPONSE_INVALID")
        raw = b" ".join(rows)
        tokens = raw.split()
        if len(raw) > 16384 or not tokens or any(not re.fullmatch(rb"[\x21-\x7e]+", token) for token in tokens):
            fail("PROVIDER_RESPONSE_INVALID")
        return {token.upper() for token in tokens}

    def require_safe_delete(self):
        if b"UIDPLUS" not in self.authenticated_capabilities():
            fail("SAFE_DRAFT_UPDATE_UNSUPPORTED")

    def remove_draft(self, ref):
        self.validate_draft(ref, writable=True)
        ok_response(self.imap.uid("STORE", ref["uid"], "+FLAGS.SILENT", "(\\Deleted)"))
        ok_response(self.imap.uid("EXPUNGE", ref["uid"]))

    def flags(self, args):
        self.reference(args, writable=True)
        uid = str(args["message"]["uid"])
        self.fetch(uid)
        changes = []
        for key, flag in (("seen", "\\Seen"), ("flagged", "\\Flagged")):
            if key in args:
                if type(args[key]) is not bool:
                    fail("INVALID_INPUT")
                changes.append((args[key], flag))
        if not changes:
            fail("INVALID_INPUT")
        for enabled, flag in changes:
            ok_response(self.imap.uid("STORE", uid, "+FLAGS.SILENT" if enabled else "-FLAGS.SILENT", f"({flag})"))
        return {"updated": True}

    def move(self, args):
        destination = text(args.get("destination"), 500)
        folder, uid, _ = self.reference(args, writable=True)
        if destination == folder:
            fail("INVALID_INPUT")
        self.fetch(uid)
        capabilities = self.authenticated_capabilities()
        if b"MOVE" in capabilities:
            ok_response(self.imap.uid("MOVE", uid, quote(encode_folder(destination))))
        elif b"UIDPLUS" in capabilities:
            ok_response(self.imap.uid("COPY", uid, quote(encode_folder(destination))))
            try:
                ok_response(self.imap.uid("STORE", uid, "+FLAGS.SILENT", "(\\Deleted)"))
                # UID EXPUNGE never touches another message marked deleted.
                ok_response(self.imap.uid("EXPUNGE", uid))
            except Exception:
                # COPY has succeeded. Retrying the whole move could duplicate
                # the destination; caller must reconcile the same reference.
                fail("MOVE_OUTCOME_UNKNOWN")
        else:
            fail("SAFE_MOVE_UNSUPPORTED")
        return {"moved": True, "destination": destination}

    def compose(self, args):
        message = EmailMessage(policy=email.policy.SMTP)
        if "from" in args and args["from"] != self.email:
            fail("INVALID_INPUT")
        message["From"] = self.email
        recipients = []
        for key in ("to", "cc", "bcc"):
            values = args.get(key, [])
            if not isinstance(values, list) or len(values) > 50:
                fail("INVALID_INPUT")
            values = [address(value) for value in values]
            recipients.extend(values)
            if values and key != "bcc":
                message[key.capitalize()] = ", ".join(values)
        if not recipients or len(recipients) > 50:
            fail("INVALID_INPUT")
        message["Subject"] = text(args.get("subject", ""), 1000, empty=True)
        message_id = text(args.get("messageId"), 500)
        if not re.fullmatch(r"<[^\s<>@]+@[^\s<>@]+>", message_id):
            fail("INVALID_INPUT")
        message["Message-ID"] = message_id
        message["Date"] = email.utils.formatdate(localtime=False)
        for key, header in (("inReplyTo", "In-Reply-To"), ("references", "References")):
            if args.get(key):
                message[header] = text(args[key], 2000)
        body = args.get("text", "")
        if not isinstance(body, str) or len(body) > MAX_TEXT or "\x00" in body:
            fail("INVALID_INPUT")
        message.set_content(body)
        attachments = args.get("attachments", [])
        if not isinstance(attachments, list) or len(attachments) > 10:
            fail("INVALID_INPUT")
        total = 0
        for item in attachments:
            if not isinstance(item, dict):
                fail("INVALID_INPUT")
            filename = text(item.get("filename"), 250)
            content_type = text(item.get("contentType", "application/octet-stream"), 100)
            if not re.fullmatch(r"[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+", content_type):
                fail("INVALID_INPUT")
            encoded = item.get("dataBase64")
            if not isinstance(encoded, str) or len(encoded) > (MAX_ATTACHMENTS * 4 // 3 + 4):
                fail("ATTACHMENT_TOO_LARGE")
            try:
                data = base64.b64decode(encoded, validate=True)
            except ValueError:
                fail("INVALID_INPUT")
            total += len(data)
            if total > MAX_ATTACHMENTS:
                fail("ATTACHMENT_TOO_LARGE")
            main, sub = content_type.split("/", 1)
            message.add_attachment(data, maintype=main, subtype=sub, filename=filename)
        raw = message.as_bytes()
        if len(raw) > MAX_MESSAGE:
            fail("MESSAGE_TOO_LARGE")
        return message, recipients, raw

    def append(self, folder, raw, draft=False):
        flags = "(\\Draft)" if draft else "(\\Seen)"
        ok_response(self.login().append(quote(encode_folder(folder)), flags, None, raw))
        # APPENDUID is the server's durable write receipt when available.
        _, values = self.imap.response("APPENDUID")
        value = values[0] if values and isinstance(values[0], bytes) else b""
        match = re.fullmatch(rb"(\d+) (\d+)", value)
        return {"folder": folder, "uidValidity": match[1].decode(), "uid": match[2].decode()} if match else {"folder": folder}

    def draft(self, args):
        previous = args.get("draft")
        if previous is not None:
            self.require_safe_delete()
            self.validate_draft(previous)
        message, _, raw = self.compose(args)
        # Bcc belongs in the private draft, but is never included in SMTP DATA.
        if args.get("bcc"):
            message["Bcc"] = ", ".join(args["bcc"])
            raw = message.as_bytes()
        if len(raw) > MAX_MESSAGE:
            fail("MESSAGE_TOO_LARGE")
        try:
            ref = self.append(self.special_folder("draft"), raw, draft=True)
        except Exception:
            # APPEND may have persisted despite a lost response. Durable caller
            # must reconcile rather than retry and create another draft.
            fail("DRAFT_OUTCOME_UNKNOWN")
        result = {"saved": True, "messageId": str(message["Message-ID"]), **ref}
        verified = False
        if "uid" not in ref:
            result["warning"] = "DRAFT_REFERENCE_UNAVAILABLE"
        else:
            try:
                _, saved_uid, _ = self.reference({"message": ref})
                saved_message, saved_flags, _ = self.fetch(saved_uid, content=True)
                if b"\\Draft" not in saved_flags or str(saved_message.get("Message-ID", "")) != str(message["Message-ID"]) or str(saved_message.get("Subject", "")) != str(message["Subject"]):
                    fail("DRAFT_READBACK_MISMATCH")
                result["fingerprint"] = hashlib.sha256(self.last_raw).hexdigest()
                result["readbackVerified"] = True
                verified = True
            except Exception:
                result["readbackVerified"] = False
                result["warning"] = "DRAFT_READBACK_UNVERIFIED"
        if previous is not None:
            result["previousDraftRemoved"] = False
            # Without the new durable UID receipt, retain the old draft for
            # recovery and disclose that cleanup has not completed.
            if verified:
                try:
                    self.remove_draft(previous)
                    result["previousDraftRemoved"] = True
                except Exception:
                    result["warning"] = "DRAFT_PREDECESSOR_CLEANUP_FAILED"
        return result

    def send(self, args):
        previous = args.get("draft")
        if previous is not None:
            self.require_safe_delete()
            self.validate_draft(previous)
        message, recipients, raw = self.compose(args)
        # Resolve sent folder before SMTP so a missing folder never causes a
        # misleading failed send that might prompt an accidental retry.
        sent_folder = self.special_folder("sent")
        smtp = self.smtp()
        try:
            code, _ = smtp.mail(self.email)
            if code != 250:
                fail("SEND_REJECTED")
            for recipient in recipients:
                code, _ = smtp.rcpt(recipient)
                if code not in (250, 251):
                    smtp.rset()
                    fail("RECIPIENT_REJECTED")
            try:
                code, _ = smtp.data(raw)
                if code != 250:
                    fail("SEND_REJECTED")
            except smtplib.SMTPDataError:
                fail("SEND_REJECTED")
            except (OSError, smtplib.SMTPServerDisconnected, ssl.SSLError):
                # The server may have accepted DATA. Never retry automatically.
                fail("SEND_OUTCOME_UNKNOWN")
        finally:
            smtp.close()
        result = {"sent": True, "smtpAccepted": True, "deliveryConfirmed": False, "messageId": str(message["Message-ID"]), "sentCopySaved": False}
        try:
            result["sentCopy"] = self.append(sent_folder, raw)
            result["sentCopySaved"] = True
        except Exception:
            # Delivery succeeded; an IMAP failure must not turn it into retryable
            # send failure. The durable caller records this completed delivery.
            result["warning"] = "SENT_COPY_FAILED"
        if previous is not None:
            result["draftRemoved"] = False
            try:
                self.remove_draft(previous)
                result["draftRemoved"] = True
            except Exception:
                result.setdefault("warnings", []).append("SENT_DRAFT_CLEANUP_FAILED")
        return result


def part_bytes(part):
    payload = part.get_payload(decode=True)
    if payload is not None:
        return payload
    if part.get_content_type() == "message/rfc822":
        return b"\r\n".join(item.as_bytes(policy=email.policy.SMTP) for item in part.get_payload())
    return b""


def iter_parts(message):
    stack = [("1", message)]
    count = 0
    while stack:
        ident, part = stack.pop()
        count += 1
        if count > MAX_PARTS or len(ident) > 100:
            fail("MESSAGE_TOO_COMPLEX")
        yield ident, part
        if part.is_multipart() and not part.get_filename() and part.get_content_disposition() != "attachment":
            children = list(part.iter_parts())
            stack.extend((f"{ident}.{index + 1}", child) for index, child in reversed(list(enumerate(children))))


def execute(request):
    if not isinstance(request, dict) or request.get("operation") not in {"verify", "folders", "list", "search", "read", "attachment", "reply", "draft_payload", "draft", "send", "flags", "move"}:
        fail("INVALID_INPUT")
    args = request.get("args", {})
    if not isinstance(args, dict):
        fail("INVALID_INPUT")
    mailbox = Mailbox(request.get("credentials"))
    try:
        operation = request["operation"]
        if operation == "verify":
            mailbox.login()
            smtp = mailbox.smtp()
            smtp.close()
            return {"verified": True, "email": mailbox.email, "imap": True, "smtp": True}
        if operation == "folders":
            return mailbox.folders()
        if operation in ("list", "search"):
            old_handler = signal.getsignal(signal.SIGALRM)
            old_timer = signal.getitimer(signal.ITIMER_REAL)
            def expire_search(_signum, _frame):
                raise SearchDeadline()
            try:
                signal.signal(signal.SIGALRM, expire_search)
                deadline = request.get("searchDeadlineAt")
                if isinstance(deadline, (int, float)) and not isinstance(deadline, bool):
                    remaining = min(SEARCH_DEADLINE_SECONDS, max(0.001, deadline / 1000 - time.time()))
                else:
                    remaining = SEARCH_DEADLINE_SECONDS
                signal.setitimer(signal.ITIMER_REAL, remaining)
                return mailbox.list_messages(args)
            except Exception as exc:
                if isinstance(exc, SearchDeadline) and mailbox.imap:
                    try:
                        mailbox.imap.shutdown()
                    except Exception:
                        pass
                    mailbox.imap = None
                # Diagnostics are deliberately allowlisted: never print exception text,
                # folder, query, address, credentials or any provider response.
                if not args.get("folder"):
                    allowed = {"TimeoutError", "ConnectionError", "ConnectionResetError", "BrokenPipeError", "OSError", "SSLError", "MailError", "ValueError", "TypeError", "RuntimeError", "error", "abort", "readonly"}
                    name = type(exc).__name__
                    if name not in allowed:
                        name = "Other"
                    try:
                        sys.stderr.write(f"AIBRAIN_MAIL_SEARCH_DIAG phase={mailbox.search_phase} exception={name}\n")
                    except OSError:
                        pass
                raise
            finally:
                signal.setitimer(signal.ITIMER_REAL, 0)
                signal.signal(signal.SIGALRM, old_handler)
                if old_timer != (0.0, 0.0):
                    signal.setitimer(signal.ITIMER_REAL, *old_timer)
        if operation == "draft_payload":
            return mailbox.draft_payload_operation(args)
        if operation in ("read", "attachment"):
            return mailbox.read(args, attachment=operation == "attachment")
        return getattr(mailbox, operation)(args)
    finally:
        mailbox.close()


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
        if len(raw) > MAX_REQUEST:
            fail("REQUEST_TOO_LARGE")
        request = json.loads(raw)
        result = {"ok": True, "result": execute(request)}
    except MailError as exc:
        result = {"ok": False, "error": {"code": exc.code}}
    except (json.JSONDecodeError, UnicodeError, TypeError, ValueError, KeyError, RecursionError):
        result = {"ok": False, "error": {"code": "INVALID_INPUT"}}
    except smtplib.SMTPAuthenticationError:
        result = {"ok": False, "error": {"code": "AUTH_FAILED"}}
    except imaplib.IMAP4.error:
        result = {"ok": False, "error": {"code": "PROVIDER_OPERATION_FAILED"}}
    except ssl.SSLError:
        result = {"ok": False, "error": {"code": "TLS_VERIFICATION_FAILED"}}
    except Exception:
        result = {"ok": False, "error": {"code": "PROVIDER_UNAVAILABLE"}}
    sys.stdout.write(json.dumps(result, ensure_ascii=True) + "\n")


if __name__ == "__main__":
    main()
