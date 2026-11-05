#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { outlookConfig } from "../lib/config.mjs";
import { createGraphClient } from "../lib/graph-client.mjs";
import { ImapSmtpClient } from "../lib/imap-smtp-client.mjs";
import { OutlookStore } from "../lib/store.mjs";
import { assertDraftCapability } from "../lib/draft-capability.mjs";

const ACTION_TYPES = new Set([
  "send_mail",
  "create_draft",
  "update_message",
  "send_draft",
  "reply",
  "reply_all",
  "forward",
  "move_message",
  "delete_message",
  "permanent_delete_message",
  "add_attachment",
  "create_folder",
  "update_folder",
  "delete_folder",
  "update_mailbox_settings",
]);

const config = outlookConfig();
const store = new OutlookStore(join(config.dataDirectory, "outlook.sqlite"));
const graph = config.provider === "microsoft_graph"
  ? createGraphClient(config, store)
  : null;
const imap = config.provider === "imap_smtp"
  ? new ImapSmtpClient(config, store)
  : null;

try {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));
  if (command === "prepare") {
    const action = validateAction(
      JSON.parse(await readFile(requiredArg(args, "input"), "utf8")),
      config,
    );
    const stored = store.prepareMailAction(action);
    print({
      status: stored.status,
      action: actionPreview(stored),
      next: `Show and approve the exact action before executing ${stored.action_id}`,
    });
  } else if (command === "show") {
    const stored = requiredStoredAction(store, requiredArg(args, "action-id"));
    print({ status: stored.status, action: actionPreview(stored, true) });
  } else if (command === "execute") {
    if (!args["confirmed-exact-action"]) {
      throw new Error("--confirmed-exact-action is required");
    }
    const actionId = requiredArg(args, "action-id");
    const approvedBy = canonicalUser(requiredArg(args, "approved-by"));
    let stored = requiredStoredAction(store, actionId);
    if (
      !stored.requested_by ||
      stored.requested_by.toLocaleLowerCase("es") !== approvedBy.toLocaleLowerCase("es")
    ) {
      throw new Error("The approving user must be the user who requested the exact action");
    }
    if (stored.status === "completed") {
      print({
        status: "already_completed",
        actionId,
        executedAt: stored.executed_at,
      });
      process.exitCode = 0;
    } else {
      stored = store.approveMailAction(actionId, approvedBy);
      if (!store.claimMailAction(actionId)) {
        throw new Error(`Mail action ${actionId} could not be claimed`);
      }
      const action = {
        id: stored.action_id,
        mailbox: stored.mailbox,
        type: stored.action_type,
        request: JSON.parse(stored.request_json),
      };
      try {
        const approval = {
          id: action.id,
          approvedBy,
          confirmed: true,
        };
        let result;
        if (imap) {
          result = await imap.executeAction(action, approval);
        } else {
          const operation = graphOperation(action, graph.mailboxRoot(action.mailbox));
          result = await graph.request(
            action.mailbox,
            operation.path,
            {
              method: operation.method,
              body: operation.body,
              approval,
            },
          );
        }
        store.completeMailAction(actionId, result);
        print({ status: "completed", actionId, result: result ?? null });
      } catch (error) {
        store.failMailAction(actionId, error);
        throw error;
      }
    }
  } else if (command === "cancel") {
    const actionId = requiredArg(args, "action-id");
    const reason = requiredArg(args, "reason");
    const stored = store.cancelMailAction(actionId, reason);
    print({ status: stored.status, action: actionPreview(stored, true) });
  } else {
    throw new Error(
      "Usage: mail-action.mjs prepare --input FILE | show --action-id ID | execute --action-id ID --approved-by NAME --confirmed-exact-action | cancel --action-id ID --reason TEXT",
    );
  }
} catch (error) {
  console.error(JSON.stringify({
    status: "error",
    code: error.code ?? null,
    responseStatus: error.responseStatus ?? null,
    command: error.executedCommand ?? error.command ?? null,
    message: error.message,
  }));
  process.exitCode = 1;
} finally {
  store.close();
}

function validateAction(action, configValue) {
  if (!action || typeof action !== "object") throw new Error("Action must be JSON");
  if (typeof action.id !== "string" || action.id.trim().length < 8) {
    throw new Error("Action id must contain at least 8 characters");
  }
  const mailbox = String(action.mailbox ?? "").trim().toLowerCase();
  if (!configValue.mailboxes.some((item) => item.address === mailbox)) {
    throw new Error("Action mailbox is outside the approved Trinalum scope");
  }
  if (!ACTION_TYPES.has(action.type)) {
    throw new Error(`Unsupported mail action type: ${action.type}`);
  }
  if (!action.request || typeof action.request !== "object") {
    throw new Error("Action request is required");
  }
  const requestedBy = canonicalUser(action.requestedBy);
  const mailboxOwner = configValue.mailboxes.find((item) => item.address === mailbox)?.name;
  if (
    requestedBy !== "David" &&
    requestedBy.toLocaleLowerCase("es") !== mailboxOwner?.toLocaleLowerCase("es")
  ) {
    throw new Error("The requesting user is not authorised for this mailbox");
  }
  if (action.type === "create_draft") assertDraftCapability(configValue, store, mailbox);
  graphOperation({ ...action, mailbox });
  return { ...action, mailbox, requestedBy };
}

function graphOperation(action, root = "/me") {
  const request = action.request;
  switch (action.type) {
    case "send_mail":
      requiredObject(request.message, "message");
      return {
        path: `${root}/sendMail`,
        method: "POST",
        body: {
          message: request.message,
          saveToSentItems: request.saveToSentItems !== false,
        },
      };
    case "create_draft":
      requiredObject(request.message, "message");
      return { path: `${root}/messages`, method: "POST", body: request.message };
    case "update_message":
      return {
        path: `${root}/messages/${encodeId(request.messageId, "messageId")}`,
        method: "PATCH",
        body: requiredObject(request.changes, "changes"),
      };
    case "send_draft":
      return {
        path: `${root}/messages/${encodeId(request.messageId, "messageId")}/send`,
        method: "POST",
      };
    case "reply":
    case "reply_all":
      return {
        path: `${root}/messages/${encodeId(request.messageId, "messageId")}/${
          action.type === "reply" ? "reply" : "replyAll"
        }`,
        method: "POST",
        body: replyBody(request),
      };
    case "forward":
      return {
        path: `${root}/messages/${encodeId(request.messageId, "messageId")}/forward`,
        method: "POST",
        body: {
          comment: String(request.comment ?? ""),
          toRecipients: requiredArray(request.toRecipients, "toRecipients"),
        },
      };
    case "move_message":
      return {
        path: `${root}/messages/${encodeId(request.messageId, "messageId")}/move`,
        method: "POST",
        body: { destinationId: requiredString(request.destinationId, "destinationId") },
      };
    case "delete_message":
      return {
        path: `${root}/messages/${encodeId(request.messageId, "messageId")}`,
        method: "DELETE",
      };
    case "permanent_delete_message":
      return {
        path: `${root}/messages/${encodeId(request.messageId, "messageId")}/permanentDelete`,
        method: "POST",
      };
    case "add_attachment":
      return {
        path: `${root}/messages/${encodeId(request.messageId, "messageId")}/attachments`,
        method: "POST",
        body: requiredObject(request.attachment, "attachment"),
      };
    case "create_folder":
      return {
        path: `${root}/mailFolders`,
        method: "POST",
        body: requiredObject(request.folder, "folder"),
      };
    case "update_folder":
      return {
        path: `${root}/mailFolders/${encodeId(request.folderId, "folderId")}`,
        method: "PATCH",
        body: requiredObject(request.changes, "changes"),
      };
    case "delete_folder":
      return {
        path: `${root}/mailFolders/${encodeId(request.folderId, "folderId")}`,
        method: "DELETE",
      };
    case "update_mailbox_settings":
      return {
        path: `${root}/mailboxSettings`,
        method: "PATCH",
        body: requiredObject(request.settings, "settings"),
      };
    default:
      throw new Error(`Unsupported mail action type: ${action.type}`);
  }
}

function actionPreview(stored, includeRequest = false) {
  return {
    id: stored.action_id,
    mailbox: stored.mailbox,
    type: stored.action_type,
    requestHash: stored.request_hash,
    requestedBy: stored.requested_by,
    approvedBy: stored.approved_by,
    createdAt: stored.created_at,
    approvedAt: stored.approved_at,
    executedAt: stored.executed_at,
    ...(includeRequest ? { request: JSON.parse(stored.request_json) } : {}),
  };
}

function requiredStoredAction(storeValue, actionId) {
  const stored = storeValue.mailAction(actionId);
  if (!stored) throw new Error(`Mail action ${actionId} was not prepared`);
  return stored;
}

function replyBody(request) {
  if (request.message) return { message: requiredObject(request.message, "message") };
  return { comment: requiredString(request.comment, "comment") };
}

function requiredObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function requiredArray(value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} must be a non-empty array`);
  }
  return value;
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function encodeId(value, name) {
  return encodeURIComponent(requiredString(value, name));
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (!item.startsWith("--")) throw new Error(`Unexpected argument ${item}`);
    const key = item.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
    } else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

function requiredArg(args, name) {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`--${name} is required`);
  return value;
}

function canonicalUser(value) {
  const requested = String(value ?? "").trim().toLocaleLowerCase("es");
  const user = [...config.mailboxes.map(account=>account.name),...(config.operatorName?[config.operatorName]:[])]
    .find((item) => item.toLocaleLowerCase("es") === requested);
  if (!user) throw new Error("requestedBy/approved-by must match a configured mailbox owner or operator");
  return user;
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}
