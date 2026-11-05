import test from "node:test";
import assert from "node:assert/strict";
import {
  assertGraphActionAllowed,
  DelegatedGraphClient,
} from "../lib/graph-client.mjs";

test("review_only permits reads and subscription maintenance", () => {
  assert.doesNotThrow(() =>
    assertGraphActionAllowed("/me/messages", { method: "GET" }, "review_only"));
  assert.doesNotThrow(() =>
    assertGraphActionAllowed("/subscriptions", { method: "POST" }, "review_only"));
  assert.doesNotThrow(() =>
    assertGraphActionAllowed(
      "/subscriptions/subscription-id",
      { method: "PATCH" },
      "review_only",
    ));
});

test("review_only blocks every mailbox mutation despite broad Microsoft scopes", () => {
  for (const [path, method] of [
    ["/me/sendMail", "POST"],
    ["/me/messages", "POST"],
    ["/me/messages/message-id", "PATCH"],
    ["/me/messages/message-id/send", "POST"],
    ["/me/messages/message-id/move", "POST"],
    ["/me/messages/message-id", "DELETE"],
    ["/me/mailFolders", "POST"],
    ["/me/mailboxSettings", "PATCH"],
  ]) {
    assert.throws(
      () => assertGraphActionAllowed(path, { method }, "review_only"),
      (error) => error.code === "OUTLOOK_MAIL_ACTION_BLOCKED",
    );
  }
});

test("approval_required accepts only a confirmed, attributable action", () => {
  assert.throws(
    () => assertGraphActionAllowed(
      "/me/sendMail",
      { method: "POST" },
      "approval_required",
    ),
    (error) => error.code === "OUTLOOK_MAIL_APPROVAL_REQUIRED",
  );
  assert.doesNotThrow(() => assertGraphActionAllowed(
    "/me/sendMail",
    {
      method: "POST",
      approval: {
        id: "approval-20260729-001",
        approvedBy: "David",
        confirmed: true,
      },
    },
    "approval_required",
  ));
});

test("autonomous mode is a separate explicit switch", () => {
  assert.doesNotThrow(() =>
    assertGraphActionAllowed("/me/sendMail", { method: "POST" }, "autonomous"));
});

test("a delegated login can target only its configured shared mailbox root", () => {
  const graph = new DelegatedGraphClient({
    tenantId: "organizations",
    clientId: "client",
    clientSecret: "secret",
    tokenEncryptionKey: "a".repeat(64),
    store: {
      oauthAccount(mailbox) {
        assert.equal(mailbox, "administracion@example.com");
        return { principal: "nerea@example.com" };
      },
    },
  });
  assert.equal(
    graph.mailboxRoot("administracion@example.com"),
    "/users/administracion%40example.com",
  );
  assert.equal(
    graph.resource("administracion@example.com", "Inbox"),
    "/users/administracion%40example.com/mailFolders('Inbox')/messages",
  );
});
