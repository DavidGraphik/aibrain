"""Synthetic-only contract/security tests. No customer mailbox/network access."""
import base64
import importlib.util
import io
from pathlib import Path
import smtplib
import socket
import ssl
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

SPEC = importlib.util.spec_from_file_location("nominalia_mail", Path(__file__).with_name("nominalia-mail.py"))
mail = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mail)

CREDS = {"email": "test@example.com", "password": "synthetic-only-password", "cursorSecret": "ab" * 32}
REF = {"folder": "INBOX", "uid": "7", "uidValidity": "123"}
COMPOSE = {"to": ["recipient@example.net"], "cc": [], "bcc": [], "subject": "Synthetic", "text": "Test", "messageId": "<stable-id@example.com>"}
RAW = b"From: sender@example.net\r\nTo: test@example.com\r\nSubject: Synthetic\r\nMessage-ID: <test@example.net>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello\r\n"


def imap_mock(raw=RAW, flags=b"", size=None):
    imap = MagicMock()
    imap.login.return_value = ("OK", [b"logged in"])
    imap.select.return_value = ("OK", [b"1"])
    imap.list.return_value = ("OK", [b'(\\HasNoChildren) "/" "INBOX"', b'(\\Drafts) "/" "Drafts"', b'(\\Sent) "/" "Sent"'])
    imap.response.side_effect = lambda key: (key, [b"123" if key == "UIDVALIDITY" else b"8" if key == "UIDNEXT" else b"123 8"])
    imap.capabilities = (b"IMAP4rev1", b"UIDPLUS")
    imap.capability.side_effect = lambda: ("OK", [b" ".join(imap.capabilities)])
    appended = {}
    def uid(operation, *args):
        if operation == "FETCH":
            current_raw = appended.get("raw", raw) if args[0] == "8" else raw
            current_flags = b"\\Draft" if args[0] == "8" and appended else flags
            if "RFC822.SIZE" in args[1]:
                return "OK", [b"1 (UID " + args[0].encode() + b" RFC822.SIZE " + str(size if size is not None else len(current_raw)).encode() + b" FLAGS (" + current_flags + b"))"]
            return "OK", [(b"1 (UID " + args[0].encode() + b" BODY[] {" + str(len(current_raw)).encode() + b"}", current_raw), b")"]
        if operation == "SEARCH":
            return "OK", [b"7"]
        return "OK", [b"done"]
    imap.uid.side_effect = uid
    def append(folder, flags, date, content):
        appended["raw"] = content
        return "OK", [b"stored"]
    imap.append.side_effect = append
    return imap


def body_part(maintype="TEXT", subtype="PLAIN", data=b"Hello", encoding="7BIT", charset="utf-8", filename=None, disposition=None):
    import json
    atom = lambda value: json.dumps(value).encode("ascii")
    params = b'("CHARSET" ' + atom(charset) + b')' if maintype == "TEXT" else b'NIL'
    extension = b'NIL' if disposition is None else b'(' + atom(disposition) + b' ("FILENAME" ' + atom(filename or "attached.txt") + b'))'
    return b'(' + atom(maintype) + b' ' + atom(subtype) + b' ' + params + b' NIL NIL ' + atom(encoding) + b' ' + str(len(data)).encode() + (b' 1 NIL ' if maintype == "TEXT" else b' NIL ') + extension + b')'


def multipart(*children, subtype="MIXED", attachment=False):
    return b'(' + b' '.join(children) + b' "' + subtype.encode() + b'" NIL' + (b' ("ATTACHMENT" ("FILENAME" "nested.mime"))' if attachment else b' NIL') + b')'


def large_body_mock(structure, sections, flags=b""):
    imap = imap_mock(size=mail.MAX_MESSAGE + 1, flags=flags)
    imap.literal_limit = mail.MAX_MESSAGE
    previous = imap.uid.side_effect
    headers = RAW.split(b"\r\n\r\n")[0] + b"\r\n\r\n"
    def uid(operation, *args):
        if operation == "FETCH" and args[1] == "(UID BODYSTRUCTURE)":
            return "OK", [b"1 (UID 7 BODYSTRUCTURE " + structure + b")"]
        if operation == "FETCH" and "BODY.PEEK[" in args[1]:
            import re
            match = re.fullmatch(r"\(UID BODY\.PEEK\[(.+)\]<0\.(\d+)>\)", args[1])
            if not match:
                raise AssertionError("Unbounded or full-message body fetch")
            section, limit = match.group(1), int(match.group(2))
            if imap.literal_limit != limit:
                raise AssertionError("Literal must be bounded before fetching")
            data = (headers if section.startswith("HEADER.FIELDS ") else sections[section])[:limit]
            prefix = f"1 (UID 7 BODY[{section}]<0> {{{len(data)}}}".encode()
            return "OK", [(prefix, data), b")"]
        return previous(operation, *args)
    imap.uid.side_effect = uid
    return imap


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.box = mail.Mailbox(CREDS)
        self.imap = imap_mock()
        self.box.imap = self.imap

    def assertCode(self, code, fn, *args):
        with self.assertRaises(mail.MailError) as caught:
            fn(*args)
        self.assertEqual(code, caught.exception.code)

    def test_fixed_hosts_and_verified_imap_context(self):
        raw = MagicMock()
        context = ssl.create_default_context()
        self.assertTrue(context.check_hostname)
        self.assertEqual(ssl.CERT_REQUIRED, context.verify_mode)
        with patch.object(mail, "connect_socket", return_value=raw) as connect, patch.object(mail.ssl, "create_default_context", return_value=MagicMock()) as make_context:
            mail.NominaliaIMAP._create_socket(None, 1)
        connect.assert_called_once_with("pop.securemail.pro", 993)
        make_context.return_value.wrap_socket.assert_called_once_with(raw, server_hostname="pop.securemail.pro")

    def test_smtp_starttls_before_auth(self):
        smtp = MagicMock()
        events = []
        smtp.ehlo.side_effect = lambda: events.append("ehlo")
        smtp.has_extn.return_value = True
        smtp.starttls.side_effect = lambda **kw: events.append("tls")
        smtp.login.side_effect = lambda *args: events.append("login")
        with patch.object(mail, "NominaliaSMTP", return_value=smtp) as factory:
            self.box.smtp()
        factory.assert_called_once_with("authsmtp.securemail.pro", 587, timeout=15)
        self.assertEqual(["ehlo", "tls", "ehlo", "login"], events)
        context = smtp.starttls.call_args.kwargs["context"]
        self.assertTrue(context.check_hostname)
        self.assertEqual(ssl.CERT_REQUIRED, context.verify_mode)

    def test_smtp_rejects_starttls_downgrade(self):
        smtp = MagicMock()
        smtp.has_extn.return_value = False
        with patch.object(mail, "NominaliaSMTP", return_value=smtp):
            self.assertCode("TLS_REQUIRED", self.box.smtp)
        smtp.login.assert_not_called()
        smtp.close.assert_called_once()

    def test_proxy_connect_has_fixed_destination_and_auth(self):
        raw = MagicMock()
        response = b"HTTP/1.1 200 Connection established\r\n\r\n"
        raw.recv.side_effect = [bytes([byte]) for byte in response]
        with patch.dict(mail.os.environ, {"AIBRAIN_EGRESS_PROXY_URL": "http://egress-gateway:8080", "AIBRAIN_EGRESS_SERVER_TOKEN": "synthetic-token"}, clear=True), patch.object(mail.socket, "create_connection", return_value=raw) as create:
            self.assertIs(raw, mail.connect_socket(mail.IMAP_HOST, 993))
        create.assert_called_once_with(("egress-gateway", 8080), 15)
        sent = raw.sendall.call_args.args[0]
        self.assertIn(b"CONNECT pop.securemail.pro:993 HTTP/1.1", sent)
        self.assertIn(base64.b64encode(b"aibrain:synthetic-token"), sent)
        self.assertNotIn(CREDS["password"].encode(), sent)

    def test_proxy_denial_and_invalid_config_never_fallback_direct(self):
        raw = MagicMock()
        raw.recv.side_effect = [bytes([byte]) for byte in b"HTTP/1.1 403 Denied\r\n\r\n"]
        with patch.dict(mail.os.environ, {"AIBRAIN_EGRESS_PROXY_URL": "http://egress-gateway:8080", "AIBRAIN_EGRESS_SERVER_TOKEN": "x"}, clear=True), patch.object(mail.socket, "create_connection", return_value=raw) as create:
            self.assertCode("PROXY_CONNECTION_FAILED", mail.connect_socket, mail.IMAP_HOST, 993)
        self.assertEqual(1, create.call_count)
        raw.close.assert_called_once()
        with patch.dict(mail.os.environ, {"AIBRAIN_EGRESS_PROXY_URL": "https://wrong", "AIBRAIN_EGRESS_SERVER_TOKEN": "x"}, clear=True), patch.object(mail.socket, "create_connection") as create:
            self.assertCode("PROXY_CONFIGURATION_INVALID", mail.connect_socket, mail.IMAP_HOST, 993)
        create.assert_not_called()

    def test_development_direct_socket(self):
        with patch.dict(mail.os.environ, {}, clear=True), patch.object(mail.socket, "create_connection") as create:
            mail.connect_socket(mail.SMTP_HOST, 587)
        create.assert_called_once_with((mail.SMTP_HOST, 587), 15)

    def test_folders_modified_utf7_and_quotes(self):
        name = 'Esborranys "Júlia" & altres'
        self.assertEqual(name, mail.decode_folder(mail.encode_folder(name)))
        self.assertEqual(["INBOX", "Drafts", "Sent"], [row["name"] for row in self.box.folders()["folders"]])

    def test_verify_authenticates_both_without_sending(self):
        smtp = MagicMock()
        with patch.object(mail, "NominaliaIMAP", return_value=self.imap), patch.object(mail.Mailbox, "smtp", return_value=smtp):
            result = mail.execute({"operation": "verify", "credentials": CREDS})
        self.assertTrue(result["verified"])
        self.imap.login.assert_called_once_with(CREDS["email"], CREDS["password"])
        smtp.data.assert_not_called()
        self.imap.append.assert_not_called()

    def test_list_stable_uid_and_peek(self):
        result = self.box.list_messages({"folder": "INBOX", "limit": 20})
        self.assertEqual("7", result["messages"][0]["uid"])
        self.assertEqual("123", result["messages"][0]["uidValidity"])
        self.assertTrue(result["messages"][0]["unread"])
        fetches = [call.args[2] for call in self.imap.uid.call_args_list if call.args[0] == "FETCH"]
        self.assertIn("BODY.PEEK[HEADER.FIELDS", fetches[-1])
        self.imap.store.assert_not_called()

    def test_read_preserves_unseen(self):
        result = self.box.read({"message": REF})
        self.assertEqual("Hello\r\n", result["text"])
        self.assertTrue(result["unread"])
        self.imap.select.assert_called_with('"INBOX"', readonly=True)
        self.assertEqual("(UID BODY.PEEK[])", self.imap.uid.call_args_list[-1].args[2])

    def test_stale_ref_and_injected_uid_rejected_before_fetch(self):
        self.assertCode("STALE_MESSAGE_REF", self.box.read, {"message": {**REF, "uidValidity": "124"}})
        self.imap.uid.assert_not_called()
        self.assertCode("INVALID_INPUT", self.box.read, {"message": {**REF, "uid": "1:*"}})
        self.assertCode("INVALID_INPUT", self.box.read, {"message": {**REF, "folder": "INBOX\r\nLOGOUT"}})

    def test_large_message_rejected_before_body_fetch(self):
        self.box.imap = imap_mock(size=mail.MAX_MESSAGE + 1)
        self.assertCode("MESSAGE_TOO_LARGE", self.box.fetch, "7", True)
        self.assertEqual(1, self.box.imap.uid.call_count)
        self.imap = self.box.imap = imap_mock(size=mail.MAX_MESSAGE + 1)
        self.assertCode("MESSAGE_TOO_LARGE", self.box.read, {"message": REF, "partId": "1"}, True)
        self.assertEqual(1, self.imap.uid.call_count)
        self.assertCode("MESSAGE_TOO_LARGE", mail.NominaliaIMAP.read, None, mail.MAX_MESSAGE + 1)

    def test_large_mail_reads_body_after_attachment_without_fetching_attachment_bytes(self):
        encoded = b'Caf=E9 technique'
        attachment = body_part("APPLICATION", "PDF", data=b"x", filename="large.pdf", disposition="ATTACHMENT").replace(b' 1 NIL ', b' 12000000 NIL ')
        self.imap = self.box.imap = large_body_mock(multipart(attachment, body_part(data=encoded, encoding="QUOTED-PRINTABLE", charset="iso-8859-1")), {"2": encoded})
        result = self.box.read({"message": REF})
        self.assertEqual("Café technique", result["text"])
        self.assertEqual("bounded_text_parts", result["readMode"])
        self.assertTrue(result["messageTruncated"])
        self.assertFalse(result["bodyTruncated"])
        self.assertTrue(result["bodyCoverage"]["complete"])
        self.assertEqual(["2"], result["bodyCoverage"]["readSections"])
        self.assertNotIn("fingerprint", result)
        self.assertEqual("partial_message", result["fingerprintUnavailableReason"])
        self.assertTrue(result["unread"])
        self.assertEqual({"partId": "1.1", "section": "1", "filename": "large.pdf", "contentType": "application/pdf", "size": None,
                          "encodedSize": 12000000, "sizeSource": "bodystructure_encoded", "contentOmitted": True}, result["attachments"][0])
        fetches = [c.args[2] for c in self.imap.uid.call_args_list]
        self.assertTrue(all("BODY.PEEK[]" not in call for call in fetches))
        self.assertFalse(any("BODY.PEEK[1]" in call for call in fetches))
        self.imap.store.assert_not_called()
        self.imap.expunge.assert_not_called()
        self.imap.append.assert_not_called()
        self.assertEqual(mail.MAX_MESSAGE, self.imap.literal_limit)

    def test_large_nested_alternative_decodes_small_plain_and_html_parts(self):
        plain = base64.b64encode("Peça tècnica".encode())
        html = b'<p>Pi=E8ce</p>'
        structure = multipart(multipart(body_part(data=plain, encoding="BASE64"), body_part(subtype="HTML", data=html, encoding="QUOTED-PRINTABLE", charset="iso-8859-1"), subtype="ALTERNATIVE"),
                              body_part("IMAGE", "PNG", data=b"ignored", filename="inline.png", disposition="INLINE"))
        self.imap = self.box.imap = large_body_mock(structure, {"1.1": plain, "1.2": html})
        result = self.box.read({"message": REF})
        self.assertEqual("Peça tècnica", result["text"])
        self.assertEqual("<p>Pièce</p>", result["html"])
        self.assertEqual(["1.1", "1.2"], result["bodyCoverage"]["readSections"])
        self.assertEqual("1.2", result["attachments"][0]["partId"])

    def test_large_attached_text_and_attached_multipart_are_not_display_body(self):
        attached = body_part(data=b"secret attachment", filename="private.txt", disposition="ATTACHMENT")
        structure = multipart(attached, multipart(body_part(data=b"nested attached text"), attachment=True), body_part(data=b"Only body"))
        self.imap = self.box.imap = large_body_mock(structure, {"3": b"Only body"})
        result = self.box.read({"message": REF})
        self.assertEqual("Only body", result["text"])
        self.assertEqual(["3"], result["bodyCoverage"]["readSections"])
        self.assertEqual(2, len(result["attachments"]))

    def test_large_invalid_or_excessive_structure_fails_before_text_fetch(self):
        valid = body_part()
        deep = valid
        for _ in range(mail.MAX_MIME_DEPTH + 1):
            deep = multipart(deep)
        cases = [b"NIL", b"()", b'("TEXT" "PLAIN")', valid.replace(b' 5 1 ', b' -1 1 '),
                 valid.replace(b'"CHARSET" "utf-8"', b'"CHARSET" NIL'), valid.replace(b'"7BIT"', b'NIL'),
                 deep, multipart(*([valid] * mail.MAX_PARTS)), b"x" * (mail.MAX_STRUCTURE + 1),
                 valid[:-1] + b' (' + b'NIL ' * mail.MAX_STRUCTURE_NODES + b'))',
                 b'("TEXT" "PLAIN" {5}\r\nUTF-8 NIL NIL "7BIT" 5 1)']
        for index, structure in enumerate(cases):
            with self.subTest(case=index):
                self.imap = self.box.imap = large_body_mock(structure, {})
                self.assertCode("BODY_STRUCTURE_INVALID", self.box.read, {"message": REF})
                self.assertFalse(any("BODY.PEEK[" in c.args[2] for c in self.imap.uid.call_args_list))
                self.assertEqual(mail.MAX_MESSAGE, self.imap.literal_limit)

    def test_large_partial_fetch_checks_uid_section_offset_literal_and_size(self):
        structure = body_part(data=b"Hello")
        for index, replacement in enumerate([b"UID 9", b"BODY[9]<0>", b"BODY[1]<1>", b"BODY[1]", b"{999}"]):
            with self.subTest(case=index):
                self.imap = self.box.imap = large_body_mock(structure, {"1": b"Hello"})
                previous = self.imap.uid.side_effect
                def uid(operation, *args):
                    result = previous(operation, *args)
                    if operation == "FETCH" and "BODY.PEEK[1]" in args[1]:
                        prefix, data = result[1][0]
                        target = b"UID 7" if index == 0 else b"{5}" if index == 4 else b"BODY[1]<0>"
                        return "OK", [(prefix.replace(target, replacement), data), b")"]
                    return result
                self.imap.uid.side_effect = uid
                self.assertCode("PROVIDER_RESPONSE_INVALID", self.box.read, {"message": REF})
                self.assertEqual(mail.MAX_MESSAGE, self.imap.literal_limit)

    def test_large_body_structure_uid_cannot_cross_message_reference(self):
        self.assertCode("BODY_STRUCTURE_INVALID", mail.parse_bodystructure, b'1 (UID 8 BODYSTRUCTURE ' + body_part() + b')', "7")
        self.assertCode("BODY_STRUCTURE_INVALID", mail.parse_bodystructure, b'1 (UID 7 BODYSTRUCTURE ' + body_part() + b' UID 8)', "7")

    def test_large_body_budget_and_character_truncation_are_explicit(self):
        encoded = base64.b64encode(b"abcdefghijklmnopqr")
        self.imap = self.box.imap = large_body_mock(multipart(body_part(data=encoded, encoding="BASE64"), body_part(subtype="HTML", data=encoded, encoding="BASE64")), {"1": encoded, "2": encoded})
        with patch.object(mail, "MAX_BODY_PART", 12), patch.object(mail, "MAX_BODY_TRANSFER", 18), patch.object(mail, "MAX_BODY_HEADERS", 256), patch.object(mail, "MAX_TEXT", 10):
            result = self.box.read({"message": REF})
        self.assertTrue(result["bodyTruncated"])
        self.assertFalse(result["bodyCoverage"]["complete"])
        self.assertEqual(18, result["bodyCoverage"]["encodedBytesFetched"])
        self.assertLessEqual(len(result["text"]) + len(result["html"]), 10)
        self.assertNotIn("fingerprint", result)

    def test_large_body_encoding_unknown_charset_and_no_eligible_body(self):
        self.imap = self.box.imap = large_body_mock(body_part(data=b"Hello", charset="not-a-charset"), {"1": b"Hello"})
        result = self.box.read({"message": REF})
        self.assertEqual("Hello", result["text"])
        self.assertEqual(["unknown_charset_replaced_with_utf8"], result["bodyDecodingWarnings"])
        for encoding, code in [("BASE64", "BODY_PART_ENCODING_INVALID"), ("X-UNKNOWN", "BODY_PART_ENCODING_UNSUPPORTED")]:
            self.imap = self.box.imap = large_body_mock(body_part(data=b"@@@@", encoding=encoding), {"1": b"@@@@"})
            self.assertCode(code, self.box.read, {"message": REF})
        self.imap = self.box.imap = large_body_mock(body_part("IMAGE", "PNG", data=b"ignored"), {})
        self.assertCode("MESSAGE_BODY_UNAVAILABLE", self.box.read, {"message": REF})

    def test_partial_literal_guard_and_ignored_range_cannot_expand_download(self):
        self.assertCode("MESSAGE_TOO_LARGE", mail.NominaliaIMAP.read, SimpleNamespace(literal_limit=8), 9)
        self.assertCode("PROVIDER_RESPONSE_INVALID", self.box.bounded_section, "7", "1] BODY[]", 8)
        self.imap.uid.assert_not_called()
        self.imap = self.box.imap = large_body_mock(body_part(data=b"Hello"), {"1": b"Hello"})
        previous = self.imap.uid.side_effect
        def uid(operation, *args):
            result = previous(operation, *args)
            if operation == "FETCH" and "BODY.PEEK[1]" in args[1]:
                return "OK", [(b"1 (UID 7 BODY[1]<0> {6}", b"Hello!"), b")"]
            return result
        self.imap.uid.side_effect = uid
        self.assertCode("PROVIDER_RESPONSE_INVALID", self.box.read, {"message": REF})
        self.assertEqual(mail.MAX_MESSAGE, self.imap.literal_limit)

    def test_large_draft_display_and_draft_mutations_keep_complete_message_guard(self):
        for flags in (b"\\Draft", b"\\draft"):
            self.imap = self.box.imap = imap_mock(size=mail.MAX_MESSAGE + 1, flags=flags)
            self.assertCode("MESSAGE_TOO_LARGE", self.box.read, {"message": REF})
            self.assertEqual(1, self.imap.uid.call_count)
        self.imap = self.box.imap = imap_mock(size=mail.MAX_MESSAGE + 1, flags=b"\\Draft")
        self.assertCode("MESSAGE_TOO_LARGE", self.box.validate_draft, self.draft_ref())
        self.imap.append.assert_not_called()
        self.assertFalse(any(c.args[0] in ("COPY", "MOVE", "STORE", "EXPUNGE") for c in self.imap.uid.call_args_list))

    def test_large_body_requires_flags_to_prove_message_is_not_a_draft(self):
        self.imap = self.box.imap = imap_mock(size=mail.MAX_MESSAGE + 1)
        self.imap.uid.side_effect = None
        self.imap.uid.return_value = ("OK", [f"1 (UID 7 RFC822.SIZE {mail.MAX_MESSAGE + 1})".encode()])
        self.assertCode("PROVIDER_RESPONSE_INVALID", self.box.read, {"message": REF})
        self.assertEqual(1, self.imap.uid.call_count)

    def test_large_message_still_visible_in_header_listing(self):
        self.box.imap = imap_mock(size=mail.MAX_MESSAGE + 1)
        result = self.box.list_messages({})
        self.assertEqual(mail.MAX_MESSAGE + 1, result["messages"][0]["size"])

    def test_search_escapes_values_and_only_permitted_criteria(self):
        self.box.list_messages({"query": {"subject": 'hello" OR ALL', "since": "2026-10-01", "unread": True}})
        search = self.imap.uid.call_args_list[0].args
        self.assertEqual(("SEARCH", "CHARSET", "UTF-8", b"SUBJECT", b'"hello\\" OR ALL"', b"SINCE", b"01-Oct-2026", b"UNSEEN", b"UID", b"1:7"), search)
        self.assertCode("INVALID_INPUT", self.box.list_messages, {"query": {"raw": "ALL"}})
        self.assertCode("INVALID_INPUT", self.box.list_messages, {"query": "ALL"})
        self.assertCode("INVALID_INPUT", self.box.list_messages, {"query": {"since": "2026-02-30"}})
        self.assertCode("INVALID_INPUT", self.box.list_messages, {"limit": 51})

    def test_bounded_body_and_attachments(self):
        message = mail.EmailMessage()
        message.set_content("x" * (mail.MAX_TEXT + 20))
        message.add_attachment(b"file data", maintype="application", subtype="pdf", filename="test.pdf")
        self.box.imap = imap_mock(message.as_bytes())
        result = self.box.read({"message": REF})
        self.assertEqual(mail.MAX_TEXT, len(result["text"]))
        self.assertTrue(result["bodyTruncated"])
        self.assertEqual("test.pdf", result["attachments"][0]["filename"])
        attachment = self.box.read({"message": REF, "partId": result["attachments"][0]["partId"]}, attachment=True)
        self.assertEqual(b"file data", base64.b64decode(attachment["dataBase64"]))

    def test_flags_only_selected_uid(self):
        self.assertEqual({"updated": True}, self.box.flags({"message": REF, "seen": True, "flagged": False}))
        stores = [call.args for call in self.imap.uid.call_args_list if call.args[0] == "STORE"]
        self.assertEqual([("STORE", "7", "+FLAGS.SILENT", "(\\Seen)"), ("STORE", "7", "-FLAGS.SILENT", "(\\Flagged)")], stores)
        self.imap.select.assert_called_with('"INBOX"', readonly=False)

    def test_invalid_flags_do_not_partially_modify(self):
        self.assertCode("INVALID_INPUT", self.box.flags, {"message": REF, "seen": True, "flagged": "yes"})
        self.assertFalse(any(call.args[0] == "STORE" for call in self.imap.uid.call_args_list))

    def test_move_uses_uid_expunge_only(self):
        self.box.move({"message": REF, "destination": "Archive"})
        effects = [call.args for call in self.imap.uid.call_args_list if call.args[0] != "FETCH"]
        self.assertEqual([("COPY", "7", '"Archive"'), ("STORE", "7", "+FLAGS.SILENT", "(\\Deleted)"), ("EXPUNGE", "7")], effects)
        self.imap.expunge.assert_not_called()

    def test_move_capability_and_fail_closed_without_uidplus(self):
        self.imap.capabilities = (b"MOVE",)
        self.box.move({"message": REF, "destination": "Archive"})
        self.imap.uid.assert_called_with("MOVE", "7", '"Archive"')
        self.imap.reset_mock()
        self.imap.capabilities = (b"IMAP4rev1",)
        self.assertCode("SAFE_MOVE_UNSUPPORTED", self.box.move, {"message": REF, "destination": "Archive"})
        self.assertFalse(any(call.args[0] in ("STORE", "COPY", "EXPUNGE", "MOVE") for call in self.imap.uid.call_args_list))

    def test_move_uses_authenticated_capabilities_missing_from_greeting(self):
        cases = [(b"IMAP4rev1 MOVE UIDPLUS", [("MOVE", "7", '"Archive"')]),
                 (b"IMAP4rev1 UIDPLUS", [("COPY", "7", '"Archive"'), ("STORE", "7", "+FLAGS.SILENT", "(\\Deleted)"), ("EXPUNGE", "7")])]
        for capabilities, expected in cases:
            with self.subTest(capabilities=capabilities):
                self.box.imap = self.imap = imap_mock()
                self.imap.capabilities = (b"IMAP4rev1", b"AUTH=PLAIN")
                self.imap.capability.side_effect = None
                self.imap.capability.return_value = ("OK", [capabilities])
                result = self.box.move({"message": REF, "destination": "Archive"})
                self.assertEqual({"moved": True, "destination": "Archive"}, result)
                self.imap.capability.assert_called_once_with()
                effects = [call.args for call in self.imap.uid.call_args_list if call.args[0] != "FETCH"]
                self.assertEqual(expected, effects)
                self.imap.expunge.assert_not_called()

    def test_move_cached_capabilities_cannot_override_authenticated_denial(self):
        self.imap.capabilities = (b"IMAP4rev1", b"MOVE", b"UIDPLUS")
        self.imap.capability.side_effect = None
        self.imap.capability.return_value = ("OK", [b"IMAP4rev1"])
        self.assertCode("SAFE_MOVE_UNSUPPORTED", self.box.move, {"message": REF, "destination": "Archive"})
        self.imap.capability.assert_called_once_with()
        self.assertFalse(any(call.args[0] in ("STORE", "COPY", "EXPUNGE", "MOVE") for call in self.imap.uid.call_args_list))
        self.imap.expunge.assert_not_called()

    def test_move_invalid_authenticated_capability_response_has_no_effect(self):
        cases = [(("NO", [b"denied"]), "PROVIDER_OPERATION_FAILED"),
                 (("OK", []), "PROVIDER_RESPONSE_INVALID"),
                 (("OK", [None]), "PROVIDER_RESPONSE_INVALID"),
                 (("OK", [b"MOVE\x00 UIDPLUS"]), "PROVIDER_RESPONSE_INVALID"),
                 (("OK", [b"MOVE \xff"]), "PROVIDER_RESPONSE_INVALID"),
                 (("OK", [b" "]), "PROVIDER_RESPONSE_INVALID"),
                 (("OK", [b"MOVE " + b"X" * 16384]), "PROVIDER_RESPONSE_INVALID")]
        for index, (response, code) in enumerate(cases):
            with self.subTest(case=index):
                self.box.imap = self.imap = imap_mock()
                self.imap.capabilities = (b"IMAP4rev1", b"MOVE", b"UIDPLUS")
                self.imap.capability.side_effect = None
                self.imap.capability.return_value = response
                self.assertCode(code, self.box.move, {"message": REF, "destination": "Archive"})
                self.assertFalse(any(call.args[0] in ("STORE", "COPY", "EXPUNGE", "MOVE") for call in self.imap.uid.call_args_list))
                self.imap.expunge.assert_not_called()

    def test_move_copy_followed_by_failure_is_explicitly_ambiguous(self):
        previous = self.imap.uid.side_effect
        def uid(operation, *args):
            if operation == "STORE":
                raise OSError("synthetic failure after copy")
            return previous(operation, *args)
        self.imap.uid.side_effect = uid
        self.assertCode("MOVE_OUTCOME_UNKNOWN", self.box.move, {"message": REF, "destination": "Archive"})
        self.assertEqual(1, len([call for call in self.imap.uid.call_args_list if call.args[0] == "COPY"]))

    def test_header_injection_sender_spoof_and_missing_messageid_denied(self):
        self.assertCode("INVALID_INPUT", self.box.compose, {**COMPOSE, "subject": "x\r\nBcc: attacker@example.net"})
        self.assertCode("INVALID_INPUT", self.box.compose, {**COMPOSE, "from": "other@example.net"})
        self.assertCode("INVALID_INPUT", self.box.compose, {**COMPOSE, "to": ["a@example.net\r\nDATA"]})
        self.assertCode("INVALID_INPUT", self.box.compose, {**COMPOSE, "messageId": ""})

    def test_attachment_total_limit_invalid_base64_and_type(self):
        self.assertCode("INVALID_INPUT", self.box.compose, {**COMPOSE, "attachments": [{"filename": "a", "dataBase64": "invalid!"}]})
        self.assertCode("INVALID_INPUT", self.box.compose, {**COMPOSE, "attachments": [{"filename": "a", "contentType": "x/y; header", "dataBase64": ""}]})
        encoded = base64.b64encode(b"x" * (mail.MAX_ATTACHMENTS // 2 + 1)).decode()
        self.assertCode("ATTACHMENT_TOO_LARGE", self.box.compose, {**COMPOSE, "attachments": [{"filename": "a", "dataBase64": encoded}, {"filename": "b", "dataBase64": encoded}]})

    def test_draft_is_imap_append_only_preserves_bcc(self):
        with patch.object(self.box, "smtp") as smtp:
            result = self.box.draft({**COMPOSE, "bcc": ["hidden@example.net"]})
        self.assertTrue(result["saved"])
        self.assertEqual("8", result["uid"])
        self.assertEqual("123", result["uidValidity"])
        self.assertEqual('"Drafts"', self.imap.append.call_args.args[0])
        self.assertEqual("(\\Draft)", self.imap.append.call_args.args[1])
        self.assertIn(b"Bcc: hidden@example.net", self.imap.append.call_args.args[3])
        smtp.assert_not_called()

    def smtp_mock(self):
        smtp = MagicMock()
        smtp.mail.return_value = (250, b"OK")
        smtp.rcpt.return_value = (250, b"OK")
        smtp.data.return_value = (250, b"OK")
        return smtp

    def test_send_stable_id_bcc_private_and_sent_copy(self):
        smtp = self.smtp_mock()
        with patch.object(self.box, "smtp", return_value=smtp):
            result = self.box.send({**COMPOSE, "bcc": ["hidden@example.net"]})
        self.assertTrue(result["sent"])
        self.assertTrue(result["sentCopySaved"])
        self.assertEqual("<stable-id@example.com>", result["messageId"])
        raw = smtp.data.call_args.args[0]
        self.assertIn(b"Message-ID: <stable-id@example.com>", raw)
        self.assertNotIn(b"Bcc:", raw)
        self.assertIn(unittest.mock.call("hidden@example.net"), smtp.rcpt.call_args_list)
        self.assertEqual(raw, self.imap.append.call_args.args[3])

    def test_refused_recipient_sends_no_data(self):
        smtp = self.smtp_mock()
        smtp.rcpt.side_effect = [(250, b"ok"), (550, b"no")]
        with patch.object(self.box, "smtp", return_value=smtp):
            self.assertCode("RECIPIENT_REJECTED", self.box.send, {**COMPOSE, "cc": ["refused@example.net"]})
        smtp.data.assert_not_called()
        smtp.rset.assert_called_once()
        self.imap.append.assert_not_called()

    def test_ambiguous_send_is_never_retried_or_copied(self):
        smtp = self.smtp_mock()
        smtp.data.side_effect = socket.timeout("secret provider diagnostic")
        with patch.object(self.box, "smtp", return_value=smtp):
            self.assertCode("SEND_OUTCOME_UNKNOWN", self.box.send, COMPOSE)
        self.assertEqual(1, smtp.data.call_count)
        self.imap.append.assert_not_called()

    def test_send_success_copy_failure_stays_success(self):
        smtp = self.smtp_mock()
        self.imap.append.side_effect = OSError("private provider error")
        with patch.object(self.box, "smtp", return_value=smtp):
            result = self.box.send(COMPOSE)
        self.assertTrue(result["sent"])
        self.assertFalse(result["sentCopySaved"])
        self.assertEqual("SENT_COPY_FAILED", result["warning"])
        self.assertEqual(1, smtp.data.call_count)

    def test_global_search_pages_all_folders_without_duplicates_or_new_mail(self):
        pages = {"INBOX": [1, 2, 3], "Drafts": [4], "Sent": [5, 6]}
        selected = [None]
        def select(folder, readonly=True):
            selected[0] = folder.strip('"')
            return "OK", [b"1"]
        self.imap.select.side_effect = select
        self.imap.response.side_effect = lambda key: (key, [b"123" if key == "UIDVALIDITY" else str(max(pages[selected[0]], default=0) + 1).encode() if key == "UIDNEXT" else b"123 8"])
        previous = self.imap.uid.side_effect
        def uid(operation, *args):
            if operation == "SEARCH":
                values = pages[selected[0]]
                if b"UID" in args:
                    cap = int(args[args.index(b"UID") + 1].split(b":")[1])
                    values = [value for value in values if value <= cap]
                return "OK", [" ".join(map(str, values)).encode()]
            if operation == "FETCH":
                number = args[0]
                if "RFC822.SIZE" in args[1]:
                    return "OK", [f"1 (UID {number} RFC822.SIZE {len(RAW)} FLAGS ())".encode()]
                return "OK", [(b"header", RAW)]
            return previous(operation, *args)
        self.imap.uid.side_effect = uid
        first = self.box.list_messages({"limit": 2})
        pages["INBOX"].append(99)
        pages["Drafts"].append(100)
        second = self.box.list_messages({"limit": 2, "cursor": first["nextCursor"]})
        third = self.box.list_messages({"limit": 2, "cursor": second["nextCursor"]})
        self.assertEqual(["3", "2", "1", "4", "6", "5"], [row["uid"] for page in (first, second, third) for row in page["messages"]])
        self.assertFalse(third["truncated"])
        self.assertTrue(third["coverage"]["complete"])
        self.assertEqual("server_imap_only", third["coverage"]["source"])
        self.assertEqual(["INBOX"], first["coverage"]["searchedFolders"])
        self.assertEqual(["INBOX", "Drafts"], second["coverage"]["searchedFolders"])
        self.assertEqual(["INBOX", "Drafts", "Sent"], third["coverage"]["searchedFolders"])

    def test_first_page_does_not_text_search_unvisited_result_folders(self):
        selected, searched = [None], []
        def select(folder, readonly=True):
            selected[0] = folder.strip('"')
            return "OK", [b"1"]
        self.imap.select.side_effect = select
        previous = self.imap.uid.side_effect
        def uid(operation, *args):
            if operation == "SEARCH":
                searched.append(selected[0])
            return previous(operation, *args)
        self.imap.uid.side_effect = uid
        result = self.box.list_messages({"query": {"text": "mecanizado"}, "limit": 1})
        self.assertEqual(["INBOX"], searched)
        self.assertEqual(["INBOX"], result["coverage"]["searchedFolders"])
        self.assertEqual(["INBOX", "Drafts", "Sent"], [row["folder"] for row in result["coverage"]["snapshotBounds"]])
        self.assertTrue(result["nextCursor"])
        self.assertFalse(result["coverage"]["complete"])
        self.imap.store.assert_not_called()
        self.imap.expunge.assert_not_called()

    def test_search_timeout_preserves_results_and_resumes_same_snapshot_without_duplicates(self):
        # INBOX completes, then Drafts times out. A later explicit request
        # uses the signed cursor on a fresh connection to finish the snapshot.
        def fresh_login():
            self.box.imap = self.imap
            return self.imap
        with patch.object(self.box, "login", side_effect=fresh_login), patch.object(self.box, "search_ids", side_effect=[[7], TimeoutError("private provider text"), TimeoutError("private retry"), [6], [5]]) as search:
            first = self.box.list_messages({"query": {"text": "reference"}, "limit": 3})
            self.assertEqual(["7"], [row["uid"] for row in first["messages"]])
            self.assertEqual(["INBOX"], first["coverage"]["searchedFolders"])
            self.assertEqual(["INBOX"], first["coverage"]["pageFolders"])
            self.assertFalse(first["coverage"]["complete"])
            self.assertEqual({"reason": "provider_search_timeout", "folder": "Drafts", "retryable": True}, first["coverage"]["interrupted"])
            self.assertTrue(first["truncated"])
            self.assertTrue(first["nextCursor"])
            self.assertNotIn("private provider text", str(first))
            self.assertEqual(3, search.call_count)  # Exactly one retry on a fresh connection.
            self.assertEqual(2, self.imap.shutdown.call_count)
            self.box.imap = self.imap  # Simulate a fresh provider connection.
            resumed = self.box.list_messages({"query": {"text": "reference"}, "limit": 3, "cursor": first["nextCursor"]})
        all_refs = [(row["folder"], row["uid"]) for result in (first, resumed) for row in result["messages"]]
        self.assertEqual([("INBOX", "7"), ("Drafts", "6"), ("Sent", "5")], all_refs)
        self.assertEqual(len(all_refs), len(set(all_refs)))
        self.assertTrue(resumed["coverage"]["complete"])
        self.assertEqual(["INBOX", "Drafts", "Sent"], resumed["coverage"]["searchedFolders"])
        self.assertIsNone(resumed["nextCursor"])
        self.imap.store.assert_not_called()
        self.imap.expunge.assert_not_called()

    def test_first_folder_search_timeout_is_explicitly_incomplete(self):
        def fresh_login():
            self.box.imap = self.imap
            return self.imap
        with patch.object(self.box, "login", side_effect=fresh_login), patch.object(self.box, "search_ids", side_effect=TimeoutError("private")):
            result = self.box.list_messages({"folder": "INBOX", "query": {"text": "reference"}})
        self.assertEqual([], result["messages"])
        self.assertFalse(result["coverage"]["complete"])
        self.assertEqual([], result["coverage"]["searchedFolders"])
        self.assertEqual("INBOX", result["coverage"]["interrupted"]["folder"])
        self.assertTrue(result["nextCursor"])
        self.assertIn("do not claim an exhaustive search", result["coverageInstruction"])

    def test_search_retries_once_on_fresh_connection_with_same_uid_ceiling(self):
        def fresh_login():
            self.box.imap = self.imap
            return self.imap
        with patch.object(self.box, "login", side_effect=fresh_login), patch.object(self.box, "search_ids", side_effect=[TimeoutError("private"), [7]]) as search:
            result = self.box.list_messages({"folder": "INBOX", "query": {"text": "reference"}, "limit": 3})
        self.assertEqual(["7"], [row["uid"] for row in result["messages"]])
        self.assertTrue(result["coverage"]["complete"])
        self.assertIsNone(result["nextCursor"])
        self.assertEqual(search.call_args_list[0], search.call_args_list[1])
        self.imap.shutdown.assert_called_once()
        self.assertTrue(all(call.kwargs.get("readonly") is True for call in self.imap.select.call_args_list))

    def test_search_retry_rejects_changed_uidvalidity_before_second_search(self):
        with patch.object(self.box, "select", side_effect=["123", "123", "999"]), patch.object(self.box, "search_ids", side_effect=TimeoutError("private")) as search:
            self.assertCode("STALE_SEARCH_CURSOR", self.box.list_messages, {"folder": "INBOX", "query": {"text": "reference"}})
        self.assertEqual(1, search.call_count)

    def test_search_deadline_does_not_start_another_provider_retry(self):
        with patch.object(self.box, "search_ids", side_effect=mail.SearchDeadline()) as search:
            result = self.box.list_messages({"folder": "INBOX", "query": {"text": "reference"}})
        self.assertEqual(1, search.call_count)
        self.assertEqual("search_deadline", result["coverage"]["interrupted"]["reason"])
        self.assertFalse(result["coverage"]["complete"])
        self.assertTrue(result["nextCursor"])

    def test_deadline_during_fetch_keeps_interrupted_message_for_continuation(self):
        with patch.object(self.box, "fetch", side_effect=mail.SearchDeadline()):
            first = self.box.list_messages({"folder": "INBOX", "query": {"text": "reference"}})
        self.assertEqual([], first["messages"])
        self.assertFalse(first["coverage"]["complete"])
        self.assertEqual("search_deadline", first["coverage"]["interrupted"]["reason"])
        self.box.imap = self.imap
        resumed = self.box.list_messages({"folder": "INBOX", "query": {"text": "reference"}, "cursor": first["nextCursor"]})
        self.assertEqual(["7"], [row["uid"] for row in resumed["messages"]])
        self.assertTrue(resumed["coverage"]["complete"])

    def test_deadline_during_next_folder_selection_keeps_prior_matches(self):
        with patch.object(self.box, "select", side_effect=["123", "123", "123", "123", mail.SearchDeadline()]), patch.object(self.box, "search_ids", return_value=[7]):
            result = self.box.list_messages({"query": {"text": "reference"}, "limit": 3})
        self.assertEqual(["7"], [row["uid"] for row in result["messages"]])
        self.assertEqual(["INBOX"], result["coverage"]["searchedFolders"])
        self.assertEqual("Drafts", result["coverage"]["interrupted"]["folder"])
        self.assertFalse(result["coverage"]["complete"])
        self.assertTrue(result["nextCursor"])

    def test_process_deadline_interrupts_slow_search_and_returns_partial_before_transport_deadline(self):
        import time
        imap = imap_mock()
        def slow_search(*_args):
            time.sleep(2)
            return []
        started = time.monotonic()
        with patch.object(mail, "SEARCH_DEADLINE_SECONDS", 0.05), patch.object(mail, "NominaliaIMAP", return_value=imap), patch.object(mail.Mailbox, "search_ids", side_effect=slow_search):
            result = mail.execute({"operation": "search", "credentials": CREDS, "args": {"folder": "INBOX", "query": {"text": "reference"}}})
        self.assertLess(time.monotonic() - started, 1.5)
        self.assertEqual("search_deadline", result["coverage"]["interrupted"]["reason"])
        self.assertFalse(result["coverage"]["complete"])
        self.assertTrue(result["nextCursor"])
        imap.shutdown.assert_called_once()

    def test_parent_deadline_includes_child_startup_time(self):
        import time
        imap = imap_mock()
        def slow_search(*_args):
            time.sleep(2)
            return []
        started = time.monotonic()
        with patch.object(mail, "SEARCH_DEADLINE_SECONDS", 5), patch.object(mail, "NominaliaIMAP", return_value=imap), patch.object(mail.Mailbox, "search_ids", side_effect=slow_search):
            result = mail.execute({"operation": "search", "credentials": CREDS, "args": {"folder": "INBOX", "query": {"text": "reference"}}, "searchDeadlineAt": (time.time() + 0.05) * 1000})
        self.assertLess(time.monotonic() - started, 1.5)
        self.assertEqual("search_deadline", result["coverage"]["interrupted"]["reason"])
        self.assertFalse(result["coverage"]["complete"])

    def test_snapshot_uidnext_is_required_and_strict_before_query(self):
        cases = [None, [], [None], ["8"], [b"0"], [b"08"], [b"8", b"9"], [b"8 9"], [b"\xff"], [b"1" * 21]]
        for index, values in enumerate(cases):
            with self.subTest(case=index):
                self.box.imap = self.imap = imap_mock()
                self.imap.response.side_effect = lambda key: (key, [b"123"] if key == "UIDVALIDITY" else values)
                self.assertCode("PROVIDER_RESPONSE_INVALID", self.box.list_messages, {"folder": "INBOX", "query": {"text": "mecanizado"}})
                self.imap.uid.assert_not_called()
                self.imap.store.assert_not_called()
                self.imap.expunge.assert_not_called()

    def test_empty_folder_snapshot_excludes_later_new_mail_without_query(self):
        self.imap.response.side_effect = lambda key: (key, [b"123"] if key == "UIDVALIDITY" else [b"1"])
        result = self.box.list_messages({"folder": "INBOX", "query": {"text": "mecanizado"}})
        self.assertEqual([], result["messages"])
        self.assertIsNone(result["nextCursor"])
        self.assertTrue(result["coverage"]["complete"])
        self.assertEqual(1, result["coverage"]["snapshotBounds"][0]["before"])
        self.imap.uid.assert_not_called()

    def test_cursor_query_account_and_uidvalidity_bound(self):
        first = self.box.list_messages({"limit": 1})
        self.assertTrue(first["nextCursor"])
        self.assertCode("INVALID_CURSOR", self.box.list_messages, {"cursor": first["nextCursor"], "query": {"subject": "different"}})
        self.box.email = "different@example.com"
        self.assertCode("INVALID_CURSOR", self.box.list_messages, {"cursor": first["nextCursor"]})
        self.box.email = CREDS["email"]
        self.imap.response.side_effect = lambda key: (key, [b"124"])
        self.assertCode("STALE_SEARCH_CURSOR", self.box.list_messages, {"cursor": first["nextCursor"]})
        self.assertCode("INVALID_CURSOR", self.box.list_messages, {"cursor": "notbase64!"})

    def test_global_search_fails_closed_on_incomplete_folder_list(self):
        self.imap.list.return_value = ("OK", [b'(\\HasNoChildren) "/" "INBOX"'] * 501)
        self.assertCode("FOLDER_LIST_INCOMPLETE", self.box.list_messages, {})

    def test_cursor_forgery_cannot_change_scope_bounds_or_coverage(self):
        import json
        first = self.box.list_messages({"limit": 1})
        encoded, signature = first["nextCursor"].split(".")
        state = json.loads(base64.urlsafe_b64decode(encoded))
        state["pending"][0]["before"] = 999
        state["skippedCount"] = 0
        forged = base64.urlsafe_b64encode(json.dumps(state).encode()).decode() + "." + signature
        self.assertCode("INVALID_CURSOR", self.box.list_messages, {"cursor": forged})
        self.box.cursor_secret = "cd" * 32
        self.assertCode("INVALID_CURSOR", self.box.list_messages, {"cursor": first["nextCursor"]})

    def test_cursor_uses_independent_server_secret_not_mail_password(self):
        import hashlib, hmac
        first = self.box.list_messages({"limit": 1})
        encoded, signature = first["nextCursor"].split(".")
        self.assertEqual(hmac.new(bytes.fromhex(CREDS["cursorSecret"]), encoded.encode(), hashlib.sha256).hexdigest(), signature)
        old_password_key = hmac.new(CREDS["password"].encode(), ("nominalia-search-cursor-v1:" + CREDS["email"]).encode(), hashlib.sha256).digest()
        self.assertNotEqual(hmac.new(old_password_key, encoded.encode(), hashlib.sha256).hexdigest(), signature)
        self.box.password = "changed-mailbox-password"
        self.box.list_messages({"cursor": first["nextCursor"]})
        self.box.cursor_secret = None
        self.assertCode("CURSOR_KEY_NOT_CONFIGURED", self.box.list_messages, {"limit": 1})

    def test_duplicate_thread_headers_fail_before_reply_composition(self):
        self.box.imap = imap_mock(RAW.replace(b"Subject:", b"Message-ID: <another@example.net>\r\nSubject:"))
        self.assertCode("THREAD_HEADERS_INVALID", self.box.reply, {"message": REF})

    def test_draft_payload_omits_empty_optional_thread_fields(self):
        self.box.imap = imap_mock(flags=b"\\Draft")
        payload = self.box.draft_payload_operation({"draft": self.draft_ref()})
        self.assertNotIn("inReplyTo", payload)
        self.assertNotIn("references", payload)

    def test_search_participant_is_literal_bidirectional_and_cc(self):
        self.box.list_messages({"folder": "INBOX", "query": {"participant": 'person@example.net" OR ALL'}})
        args = self.imap.uid.call_args_list[0].args
        quoted = b'"person@example.net\\" OR ALL"'
        self.assertEqual(("SEARCH", "CHARSET", "UTF-8", b"OR", b"FROM", quoted, b"OR", b"TO", quoted, b"CC", quoted, b"UID", b"1:7"), args)

    def test_search_skipped_message_keeps_incomplete_coverage_across_pages(self):
        previous = self.box.fetch
        def fetch(uid, content=False):
            if self.imap.select.call_args.args[0] == '"INBOX"':
                mail.fail("MESSAGE_NOT_FOUND")
            return previous(uid, content)
        with patch.object(self.box, "fetch", side_effect=fetch):
            first = self.box.list_messages({"limit": 1})
            second = self.box.list_messages({"limit": 1, "cursor": first["nextCursor"]})
            third = self.box.list_messages({"limit": 1, "cursor": second["nextCursor"]})
        self.assertFalse(third["truncated"])
        self.assertFalse(third["coverage"]["complete"])
        self.assertEqual(1, third["coverage"]["skippedCount"])

    def test_read_exposes_thread_headers_raw_fingerprint_and_draft_bcc(self):
        raw = RAW.replace(b"Subject:", b"Reply-To: reply@example.net\r\nIn-Reply-To: <older@example.net>\r\nReferences: <first@example.net> <older@example.net>\r\nBcc: hidden@example.net\r\nSubject:")
        self.box.imap = imap_mock(raw, flags=b"\\Draft")
        view = self.box.read({"message": REF})
        self.assertEqual("reply@example.net", view["replyTo"])
        self.assertEqual("<older@example.net>", view["inReplyTo"])
        self.assertEqual("hidden@example.net", view["bcc"])
        self.assertEqual(mail.hashlib.sha256(raw).hexdigest(), view["fingerprint"])

    def test_reply_uses_replyto_chain_and_replyall_excludes_self_and_bcc(self):
        raw = RAW.replace(b"To: test@example.com", b"To: test@example.com, colleague@example.net\r\nCc: copy@example.net, colleague@example.net\r\nBcc: hidden@example.net\r\nReply-To: support@example.net\r\nReferences: <root@example.net> <parent@example.net>")
        self.box.imap = imap_mock(raw)
        payload = self.box.reply({"message": REF, "replyAll": True, "text": "Reply"})["payload"]
        self.assertEqual(["support@example.net"], payload["to"])
        self.assertEqual(["colleague@example.net", "copy@example.net"], payload["cc"])
        self.assertEqual([], payload["bcc"])
        self.assertEqual("<root@example.net> <parent@example.net> <test@example.net>", payload["references"])
        self.assertEqual("<test@example.net>", payload["inReplyTo"])
        self.assertEqual("Re: Synthetic", payload["subject"])
        self.assertEqual("Reply", payload["text"])
        self.imap.append.assert_not_called()

    def test_reply_normalizes_outer_message_id_whitespace_without_losing_parent(self):
        for value in (b"<test@example.net> ", b" <test@example.net>", b"\t<test@example.net>\t", b"<test@example.net>\r\n\t "):
            with self.subTest(value=value):
                self.box.imap = imap_mock(RAW.replace(b"Message-ID: <test@example.net>", b"Message-ID: " + value))
                payload = self.box.reply({"message": REF})["payload"]
                self.assertEqual("<test@example.net>", payload["inReplyTo"])
                self.assertEqual("<test@example.net>", payload["references"])

    def test_reply_still_rejects_multiple_parent_ids_in_one_header(self):
        raw = RAW.replace(b"<test@example.net>", b" <first@example.net> <second@example.net> ")
        self.box.imap = imap_mock(raw)
        self.assertCode("THREAD_HEADERS_INVALID", self.box.reply, {"message": REF})

    def test_reply_to_own_sent_message_targets_original_recipient(self):
        raw = RAW.replace(b"sender@example.net", b"test@example.com").replace(b"To: test@example.com", b"To: recipient@example.net")
        self.box.imap = imap_mock(raw)
        self.assertEqual(["recipient@example.net"], self.box.reply({"message": REF})["payload"]["to"])

    def test_reply_missing_or_oversized_thread_header_is_not_truncated(self):
        self.box.imap = imap_mock(RAW.replace(b"<test@example.net>", b"invalid"))
        self.assertCode("THREAD_HEADERS_INVALID", self.box.reply, {"message": REF})
        raw = RAW.replace(b"Subject:", b"References: " + b"<long@example.net> " * 150 + b"\r\nSubject:")
        self.box.imap = imap_mock(raw)
        self.assertCode("THREAD_HEADERS_TOO_LARGE", self.box.reply, {"message": REF})

    def draft_ref(self, raw=RAW):
        return {"folder": "Drafts", "uid": "7", "uidValidity": "123", "fingerprint": mail.hashlib.sha256(raw).hexdigest()}

    def test_draft_payload_preserves_attachment_bcc_and_headers(self):
        message, _, _ = self.box.compose({**COMPOSE, "inReplyTo": "<p@example.net>", "references": "<r@example.net> <p@example.net>", "attachments": [{"filename": "proof.txt", "dataBase64": base64.b64encode(b"original").decode()}]})
        message["Bcc"] = "hidden@example.net"
        raw = message.as_bytes()
        self.box.imap = imap_mock(raw, flags=b"\\Draft")
        payload = self.box.draft_payload_operation({"draft": self.draft_ref(raw)})
        self.assertEqual(["hidden@example.net"], payload["bcc"])
        self.assertEqual("<p@example.net>", payload["inReplyTo"])
        self.assertEqual(b"original", base64.b64decode(payload["attachments"][0]["dataBase64"]))

    def test_draft_html_not_silently_recomposed(self):
        message = mail.EmailMessage()
        message.set_content("<p>Only HTML</p>", subtype="html")
        raw = message.as_bytes()
        self.box.imap = imap_mock(raw, flags=b"\\Draft")
        self.assertCode("DRAFT_FORMAT_UNSUPPORTED", self.box.draft_payload_operation, {"draft": self.draft_ref(raw)})
        self.assertIn("Only HTML", self.box.read({"message": {**REF, "folder": "Drafts"}})["html"])

    def test_draft_update_removes_only_exact_predecessor_after_append(self):
        self.box.imap = self.imap = imap_mock(flags=b"\\Draft")
        result = self.box.draft({**COMPOSE, "draft": self.draft_ref()})
        self.assertTrue(result["previousDraftRemoved"])
        self.assertEqual("8", result["uid"])
        self.assertEqual(mail.hashlib.sha256(self.imap.append.call_args.args[3]).hexdigest(), result["fingerprint"])
        effects = [call.args for call in self.imap.uid.call_args_list if call.args[0] in ("STORE", "EXPUNGE")]
        self.assertEqual([("STORE", "7", "+FLAGS.SILENT", "(\\Deleted)"), ("EXPUNGE", "7")], effects)
        self.imap.expunge.assert_not_called()

    def test_draft_mismatched_fingerprint_folder_flags_and_unsafe_delete_are_denied(self):
        self.box.imap = self.imap = imap_mock(flags=b"\\Draft")
        self.assertCode("STALE_DRAFT_FINGERPRINT", self.box.draft, {**COMPOSE, "draft": {**self.draft_ref(), "fingerprint": "0" * 64}})
        self.assertCode("NOT_A_DRAFT", self.box.draft, {**COMPOSE, "draft": {**self.draft_ref(), "folder": "INBOX"}})
        self.box.imap = imap_mock()
        self.assertCode("NOT_A_DRAFT", self.box.draft, {**COMPOSE, "draft": self.draft_ref()})
        self.box.imap = self.imap
        self.imap.capabilities = (b"IMAP4rev1",)
        self.assertCode("SAFE_DRAFT_UPDATE_UNSUPPORTED", self.box.draft, {**COMPOSE, "draft": self.draft_ref()})
        self.imap.append.assert_not_called()

    def test_draft_edit_uses_post_auth_uidplus_not_cached_greeting(self):
        self.box.imap = self.imap = imap_mock(flags=b"\\Draft")
        self.imap.capabilities = (b"IMAP4rev1", b"AUTH=PLAIN")
        self.imap.capability.side_effect = None
        self.imap.capability.return_value = ("OK", [b"IMAP4rev1 MOVE UIDPLUS"])
        result = self.box.draft({**COMPOSE, "draft": self.draft_ref()})
        self.assertTrue(result["previousDraftRemoved"])
        self.imap.capability.assert_called_once_with()
        self.imap.uid.assert_any_call("EXPUNGE", "7")
        self.imap.expunge.assert_not_called()

    def test_cached_uidplus_cannot_override_authenticated_capability_denial(self):
        self.box.imap = self.imap = imap_mock(flags=b"\\Draft")
        self.imap.capability.side_effect = None
        self.imap.capability.return_value = ("OK", [b"IMAP4rev1"])
        with patch.object(self.box, "smtp") as smtp:
            self.assertCode("SAFE_DRAFT_UPDATE_UNSUPPORTED", self.box.draft, {**COMPOSE, "draft": self.draft_ref()})
            self.assertCode("SAFE_DRAFT_UPDATE_UNSUPPORTED", self.box.send, {**COMPOSE, "draft": self.draft_ref()})
        self.imap.append.assert_not_called()
        self.imap.uid.assert_not_called()
        self.imap.expunge.assert_not_called()
        smtp.assert_not_called()

    def test_post_auth_capability_failure_or_malformed_response_has_no_effect(self):
        cases = [(("NO", [b"denied"]), "PROVIDER_OPERATION_FAILED"),
                 (("OK", []), "PROVIDER_RESPONSE_INVALID"),
                 (("OK", [None]), "PROVIDER_RESPONSE_INVALID"),
                 (("OK", [b"UIDPLUS\x00"]), "PROVIDER_RESPONSE_INVALID"),
                 (("OK", [b"UIDPLUS \xff"]), "PROVIDER_RESPONSE_INVALID"),
                 (("OK", [b" "]), "PROVIDER_RESPONSE_INVALID")]
        for response, code in cases:
            with self.subTest(response=response):
                self.box.imap = self.imap = imap_mock(flags=b"\\Draft")
                self.imap.capability.side_effect = None
                self.imap.capability.return_value = response
                self.assertCode(code, self.box.draft, {**COMPOSE, "draft": self.draft_ref()})
                self.imap.append.assert_not_called()
                self.imap.uid.assert_not_called()
                self.imap.expunge.assert_not_called()

    def test_draft_fingerprint_uses_provider_readback_not_submitted_bytes(self):
        original_append = self.imap.append.side_effect
        def append(folder, flags, date, content):
            return original_append(folder, flags, date, b"X-Provider: normalized\r\n" + content)
        self.imap.append.side_effect = append
        result = self.box.draft(COMPOSE)
        submitted = self.imap.append.call_args.args[3]
        self.assertTrue(result["readbackVerified"])
        self.assertEqual(mail.hashlib.sha256(b"X-Provider: normalized\r\n" + submitted).hexdigest(), result["fingerprint"])

    def test_draft_readback_failure_retains_predecessor_and_no_false_fingerprint(self):
        self.box.imap = self.imap = imap_mock(flags=b"\\Draft")
        original_fetch = self.box.fetch
        def fetch(uid, content=False):
            if uid == "8":
                raise OSError("readback failed")
            return original_fetch(uid, content)
        with patch.object(self.box, "fetch", side_effect=fetch), patch.object(self.box, "remove_draft") as remove:
            result = self.box.draft({**COMPOSE, "draft": self.draft_ref()})
        self.assertTrue(result["saved"])
        self.assertFalse(result["readbackVerified"])
        self.assertNotIn("fingerprint", result)
        self.assertFalse(result["previousDraftRemoved"])
        self.assertEqual("DRAFT_READBACK_UNVERIFIED", result["warning"])
        remove.assert_not_called()

    def test_draft_update_cleanup_failure_returns_success_and_warning(self):
        self.box.imap = self.imap = imap_mock(flags=b"\\Draft")
        with patch.object(self.box, "remove_draft", side_effect=OSError("lost response")):
            result = self.box.draft({**COMPOSE, "draft": self.draft_ref()})
        self.assertTrue(result["saved"])
        self.assertFalse(result["previousDraftRemoved"])
        self.assertEqual("DRAFT_PREDECESSOR_CLEANUP_FAILED", result["warning"])
        self.assertEqual(1, self.imap.append.call_count)

    def test_draft_append_ambiguous_is_not_retried(self):
        self.imap.append.side_effect = OSError("lost response")
        self.assertCode("DRAFT_OUTCOME_UNKNOWN", self.box.draft, COMPOSE)
        self.assertEqual(1, self.imap.append.call_count)

    def test_send_existing_draft_validates_before_smtp_and_consumes_after_success(self):
        self.box.imap = self.imap = imap_mock(flags=b"\\Draft")
        smtp = self.smtp_mock()
        with patch.object(self.box, "smtp", return_value=smtp):
            result = self.box.send({**COMPOSE, "draft": self.draft_ref()})
        self.assertTrue(result["sent"])
        self.assertTrue(result["draftRemoved"])
        self.assertEqual(1, smtp.data.call_count)
        self.imap.expunge.assert_not_called()
        smtp.reset_mock()
        with patch.object(self.box, "smtp", return_value=smtp):
            self.assertCode("STALE_DRAFT_FINGERPRINT", self.box.send, {**COMPOSE, "draft": {**self.draft_ref(), "fingerprint": "0" * 64}})
        smtp.data.assert_not_called()

    def test_send_existing_draft_ambiguous_preserves_draft(self):
        self.box.imap = self.imap = imap_mock(flags=b"\\Draft")
        smtp = self.smtp_mock()
        smtp.data.side_effect = socket.timeout()
        with patch.object(self.box, "smtp", return_value=smtp), patch.object(self.box, "remove_draft") as remove:
            self.assertCode("SEND_OUTCOME_UNKNOWN", self.box.send, {**COMPOSE, "draft": self.draft_ref()})
        remove.assert_not_called()

    def test_send_existing_draft_cleanup_failure_is_success_not_retry(self):
        self.box.imap = self.imap = imap_mock(flags=b"\\Draft")
        smtp = self.smtp_mock()
        with patch.object(self.box, "smtp", return_value=smtp), patch.object(self.box, "remove_draft", side_effect=OSError("lost response")):
            result = self.box.send({**COMPOSE, "draft": self.draft_ref()})
        self.assertTrue(result["sent"])
        self.assertFalse(result["draftRemoved"])
        self.assertIn("SENT_DRAFT_CLEANUP_FAILED", result["warnings"])
        self.assertEqual(1, smtp.data.call_count)

    def test_mime_depth_is_bounded(self):
        message = mail.EmailMessage()
        message.set_content("x")
        for _ in range(mail.MAX_PARTS + 2):
            outer = mail.EmailMessage()
            outer.make_mixed()
            outer.attach(message)
            message = outer
        self.assertCode("MESSAGE_TOO_COMPLEX", list, mail.iter_parts(message))

    def test_main_sanitizes_errors_and_no_credential_output(self):
        import json
        request = json.dumps({"operation": "verify", "credentials": CREDS}).encode()
        stdin = MagicMock(buffer=io.BytesIO(request))
        stdout = io.StringIO()
        with patch.object(mail.sys, "stdin", stdin), patch.object(mail.sys, "stdout", stdout), patch.object(mail, "execute", side_effect=OSError(CREDS["password"])):
            mail.main()
        self.assertEqual({"ok": False, "error": {"code": "PROVIDER_UNAVAILABLE"}}, json.loads(stdout.getvalue()))
        self.assertNotIn(CREDS["password"], stdout.getvalue())

    def test_search_diagnostic_reports_only_phase_and_exception_class(self):
        self.imap.select.side_effect = TimeoutError("secret folder and provider message")
        stderr = io.StringIO()
        with patch.object(mail, "Mailbox", return_value=self.box), patch.object(mail.sys, "stderr", stderr):
            with self.assertRaises(TimeoutError):
                mail.execute({"operation": "search", "credentials": CREDS, "args": {"query": {"text": "private query"}}})
        self.assertEqual("AIBRAIN_MAIL_SEARCH_DIAG phase=snapshot_select exception=TimeoutError\n", stderr.getvalue())
        self.assertNotIn("secret", stderr.getvalue())
        self.assertNotIn("private", stderr.getvalue())

    def test_successful_search_emits_no_diagnostic(self):
        stderr = io.StringIO()
        with patch.object(mail, "Mailbox", return_value=self.box), patch.object(mail.sys, "stderr", stderr):
            result = mail.execute({"operation": "search", "credentials": CREDS, "args": {"folder": "INBOX", "limit": 1}})
        self.assertEqual(1, len(result["messages"]))
        self.assertEqual("", stderr.getvalue())

    def test_folder_search_failure_has_no_global_diagnostic(self):
        self.imap.select.side_effect = TimeoutError("private provider details")
        stderr = io.StringIO()
        with patch.object(mail, "Mailbox", return_value=self.box), patch.object(mail.sys, "stderr", stderr):
            with self.assertRaises(TimeoutError):
                mail.execute({"operation": "search", "credentials": CREDS, "args": {"folder": "INBOX"}})
        self.assertEqual("", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
