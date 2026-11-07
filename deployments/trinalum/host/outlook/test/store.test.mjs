import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import {tmpdir as nativeTmpdir} from 'node:os';
import {realpathSync as canonicalTmpPath} from 'node:fs';
const tmpdir=()=>canonicalTmpPath(nativeTmpdir());
import { OutlookStore } from "../lib/store.mjs";

test("deduplicates, claims and completes notifications", () => {
  const directory = mkdtempSync(join(tmpdir(), "trinalum-outlook-"));
  const store = new OutlookStore(join(directory, "test.sqlite"));
  const notification = {
    id: "notification-1",
    subscriptionId: "subscription-1",
    changeType: "created",
    resource: "Users/example/Messages/message-1",
    resourceData: { id: "message-1" },
    payload: {},
  };
  assert.equal(store.enqueue(notification), true);
  assert.equal(store.enqueue(notification), false);
  assert.equal(store.claim("notification-1"), true);
  store.complete("notification-1", "/private/snapshot.json");
  assert.equal(store.stats().notifications.processed, 1);
  store.close();
});

test("mail actions preserve exact approved content and execute once", () => {
  const directory = mkdtempSync(join(tmpdir(), "trinalum-outlook-actions-"));
  const store = new OutlookStore(join(directory, "test.sqlite"));
  const action = {
    id: "mail-action-001",
    mailbox: "miguel@example.com",
    type: "send_mail",
    requestedBy: "Miguel",
    request: {
      message: {
        subject: "Oferta",
        toRecipients: [{ emailAddress: { address: "cliente@example.com" } }],
        body: { contentType: "Text", content: "Contenido exacto" },
      },
    },
  };
  assert.equal(store.prepareMailAction(action).status, "prepared");
  assert.equal(store.prepareMailAction({
    ...action,
    request: {
      message: {
        body: { content: "Contenido exacto", contentType: "Text" },
        toRecipients: [{ emailAddress: { address: "cliente@example.com" } }],
        subject: "Oferta",
      },
    },
  }).status, "prepared");
  assert.throws(
    () => store.prepareMailAction({
      ...action,
      request: { message: { ...action.request.message, subject: "Otro asunto" } },
    }),
    /different exact content/,
  );
  assert.equal(store.approveMailAction(action.id, "Miguel + David").status, "approved");
  assert.equal(store.claimMailAction(action.id), true);
  assert.equal(store.claimMailAction(action.id), false);
  store.completeMailAction(action.id, { accepted: true });
  assert.equal(store.mailAction(action.id).status, "completed");
  assert.equal(store.claimMailAction(action.id), false);
  store.close();
});

test("a failed unsupported action can be closed without external execution", () => {
  const directory = mkdtempSync(join(tmpdir(), "trinalum-outlook-actions-"));
  const store = new OutlookStore(join(directory, "test.sqlite"));
  const action = {
    id: "mail-action-unsupported-001",
    mailbox: "miguel@example.com",
    type: "create_draft",
    requestedBy: "Miguel",
    request: { message: { subject: "Draft" } },
  };
  store.prepareMailAction(action);
  store.approveMailAction(action.id, "Miguel");
  store.claimMailAction(action.id);
  store.failMailAction(action.id, new Error("Unsupported provider operation"));
  const cancelled = store.cancelMailAction(
    action.id,
    "Use the approval card and send_mail after exact approval",
  );
  assert.equal(cancelled.status, "cancelled");
  assert.match(cancelled.last_error, /approval card/);
  store.close();
});

test("stores encrypted mailbox credentials and independent IMAP cursors", () => {
  const directory = mkdtempSync(join(tmpdir(), "trinalum-mail-credentials-"));
  const store = new OutlookStore(join(directory, "test.sqlite"));
  store.createCredentialState("one-time-state", "trini@example.com");
  assert.ok(store.consumeCredentialState("one-time-state", "trini@example.com"));
  assert.equal(store.consumeCredentialState("one-time-state", "trini@example.com"), null);

  store.upsertMailCredential({
    mailbox: "trini@example.com",
    owner: "Trini",
    passwordEncrypted: "v1.encrypted.payload.value",
    folders: { inbox: "INBOX", sent: "Sent" },
  });
  assert.equal(
    store.mailCredential("trini@example.com").password_encrypted,
    "v1.encrypted.payload.value",
  );
  assert.equal(store.stats().mailCredentials.length, 1);

  store.setImapState("trini@example.com", "Inbox", "12345", 678);
  assert.deepEqual(
    {
      uidValidity: store.getImapState("trini@example.com", "Inbox").uid_validity,
      lastUid: store.getImapState("trini@example.com", "Inbox").last_uid,
    },
    { uidValidity: "12345", lastUid: 678 },
  );
  store.close();
});
