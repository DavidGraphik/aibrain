#!/usr/bin/env node

import {outlookConfig} from "../lib/config.mjs";
import { pathToFileURL } from "node:url";
import { iterateSnapshots } from "../lib/snapshot-reader.mjs";
import { compileMailSearchQuery } from "../lib/mail-search-query.mjs";
import { mailSnapshotReference } from "../lib/mail-reference.mjs";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try { await runCli(); } catch (error) {
    console.error(JSON.stringify({status:"error",code:error.code??"MAIL_SEARCH_FAILED",message:"Invalid or unsupported mailbox search query"}));process.exitCode=1;
  }
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const config = outlookConfig();
  const mailbox = requiredMailbox(args.mailbox, config);
  const query = requiredText(args.query, "--query");
  const limit = positiveInteger(args.limit ?? "20", "--limit", 50);
  const sinceDays = positiveInteger(args["since-days"] ?? "3650", "--since-days", 3650);
  const maxTextChars = positiveInteger(
    args["max-text-chars"] ?? "1200",
    "--max-text-chars",
    5000,
  );
  const dataDirectory = config.dataDirectory;
  console.log(
    JSON.stringify(
      await searchSnapshotDirectory(`${dataDirectory}/delta`, { mailbox, query, limit, sinceDays, maxTextChars }),
    ),
  );
}

export async function searchSnapshotDirectory(directory, options) {
  const predicate=compileMailSearchQuery(options.query);
  let matches = [],totalMatches=0;
  for await (const snapshot of iterateSnapshots(directory)) {
    const found = searchMessages([snapshot], options, predicate).messages;
    totalMatches+=found.length;
    if (!found.length) continue;
    matches.push(...found);
    // Keep only the projected, bounded top results, never raw message bodies.
    matches.sort((a,b)=>b.occurred_at.localeCompare(a.occurred_at)||a.snapshot_id.localeCompare(b.snapshot_id));
    matches = matches.slice(0,options.limit);
  }
  return {source:'Outlook-compatible mail',mailbox:options.mailbox,query:options.query,count:matches.length,total_matches:totalMatches,truncated:totalMatches>matches.length,messages:matches};
}

export function searchMessages(messages, options, predicate = compileMailSearchQuery(options.query)) {
  const { mailbox, query, limit, sinceDays, maxTextChars } = options;
  const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  const matches = messages
    .filter((message) => message.mailbox === mailbox)
    .filter((message) => message.date.getTime() >= cutoff)
    .filter(predicate)
    .map(message=>({message}))
    .sort((left, right) => right.message.date.getTime() - left.message.date.getTime())
    .slice(0, limit)
    .map(({ message }) => ({
      message_id: mailSnapshotReference(message.snapshotId) ?? message.data.id,
      original_message_id: message.data.id,
      snapshot_id: message.snapshotId,
      mailbox: message.mailbox,
      direction: message.folder === "SentItems" ? "sent" : "received",
      occurred_at: message.date.toISOString(),
      subject: cleanText(message.data.subject, 300),
      from: message.from,
      external_recipients: message.externalRecipients,
      has_attachments: Boolean(message.data.hasAttachments),
      attachments: (message.data.attachments ?? []).slice(0, 20).map((attachment) => ({
        filename: cleanText(attachment.filename ?? attachment.name, 500),
        content_type: cleanText(attachment.contentType, 200),
      })),
      text: cleanText(message.data.text, maxTextChars),
    }));
  return {
    source: "Outlook-compatible mail",
    mailbox,
    query,
    count: matches.length,
    messages: matches,
  };
}

function requiredMailbox(value, config) {
  const mailbox = String(value ?? "").trim().toLocaleLowerCase("en");
  const allowed = new Set(config.mailboxes.map(item=>item.address));
  if (!allowed.has(mailbox)) throw new Error("--mailbox must be a connected mailbox");
  return mailbox;
}

function requiredText(value, flag) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${flag} is required`);
  return text;
}

function cleanText(value, maximum) {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, maximum);
}

function positiveInteger(value, flag, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${flag} must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    if (!key?.startsWith("--")) throw new Error(`Unexpected argument ${key}`);
    const value = values[index + 1];
    if (value === undefined) throw new Error(`${key} requires a value`);
    parsed[key.slice(2)] = value;
  }
  return parsed;
}
