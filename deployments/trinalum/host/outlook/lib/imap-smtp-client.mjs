import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { decryptToken, encryptToken } from "./token-crypto.mjs";
import { smtpMessage } from "./mail-mime.mjs";
import { writeMailSnapshot } from "./mail-snapshot.mjs";

export class ImapSmtpClient {
  constructor(config, store, options = {}) {
    this.config = config;
    this.store = store;
    this.ImapFlow = options.ImapFlow ?? ImapFlow;
    this.nodemailer = options.nodemailer ?? nodemailer;
    this.simpleParser = options.simpleParser ?? simpleParser;
    this.authMode = "password";
    this.provider = "imap_smtp";
  }

  isConnected(mailbox) {
    return Boolean(this.store.mailCredential(mailbox));
  }

  async verifyAndSave(mailbox, password) {
    const account = this.config.mailboxes.find((item) => item.address === mailbox);
    if (!account) throw publicError("Buzón no autorizado", "MAILBOX_NOT_ALLOWED");
    if (typeof password !== "string" || password.length < 1 || password.length > 1024) {
      throw publicError("Introduce la contraseña del correo", "PASSWORD_REQUIRED");
    }

    const folders = await this.inspectImap(mailbox, password);
    await this.verifySmtp(mailbox, password);
    this.store.upsertMailCredential({
      mailbox,
      owner: account.name,
      passwordEncrypted: encryptToken(password, this.config.tokenEncryptionKey),
      folders,
    });
    return { mailbox, owner: account.name, folders };
  }

  async inspectImap(mailbox, password) {
    return this.withImapPassword(mailbox, password, async (client) => {
      const listed = await client.list();
      return folderMap(listed);
    });
  }

  async verifySmtp(mailbox, password) {
    const transport = this.smtpTransport(mailbox, password);
    try {
      await transport.verify();
    } catch (error) {
      if (isAuthenticationError(error)) {
        throw publicError(
          "La contraseña no es correcta o el proveedor no permite el acceso",
          "MAIL_AUTHENTICATION_FAILED",
        );
      }
      throw error;
    } finally {
      transport.close();
    }
  }

  async syncMailbox(mailbox, outputDirectory) {
    const credential = this.requiredCredential(mailbox);
    const folders = JSON.parse(credential.folders_json);
    const password = decryptToken(
      credential.password_encrypted,
      this.config.tokenEncryptionKey,
    );
    return this.withImapPassword(mailbox, password, async (client) => {
      await mkdir(outputDirectory, { recursive: true });
      const results = [];
      for (const [logicalFolder, path] of [
        ["Inbox", folders.inbox],
        ["SentItems", folders.sent],
      ]) {
        if (!path) {
          results.push({ folder: logicalFolder, action: "folder_not_available" });
          continue;
        }
        results.push(await this.syncFolder(
          client,
          mailbox,
          logicalFolder,
          path,
          outputDirectory,
        ));
      }
      return results;
    });
  }

  async syncFolder(client, mailbox, logicalFolder, path, outputDirectory) {
    const lock = await client.getMailboxLock(path, { readOnly: true });
    try {
      const uidValidity = String(client.mailbox.uidValidity);
      const previous = this.store.getImapState(mailbox, logicalFolder);
      const currentLastUid = Math.max(0, Number(client.mailbox.uidNext ?? 1) - 1);
      let selectedUids;
      if (previous?.uid_validity === uidValidity) {
        const firstUid = Number(previous.last_uid) + 1;
        selectedUids = firstUid <= currentLastUid
          ? await client.search({ uid: `${firstUid}:*` }, { uid: true })
          : [];
      } else {
        const allUids = await client.search({ all: true }, { uid: true });
        selectedUids = allUids.slice(-this.config.initialSyncLimit);
      }
      selectedUids = selectedUids.map(Number).filter(Number.isSafeInteger);

      let stored = 0;
      for (const uid of selectedUids) {
        const metadata = await client.fetchOne(
          uid,
          {
            uid: true,
            envelope: true,
            flags: true,
            internalDate: true,
            size: true,
            bodyStructure: true,
          },
          { uid: true },
        );
        if (!metadata) continue;

        let parsed = null;
        if (Number(metadata.size ?? 0) <= this.config.maxMessageBytes) {
          const complete = await client.fetchOne(uid, { source: true }, { uid: true });
          if (complete?.source) {
            parsed = await this.simpleParser(complete.source, {
              skipImageLinks: true,
              skipHtmlToText: false,
            });
          }
        }

        const messageRef = encodeMessageRef(path, uidValidity, uid);
        const snapshot = {
          source: "imap",
          mailbox,
          folder: logicalFolder,
          folderPath: path,
          fetched_at: new Date().toISOString(),
          data: normalizeMessage(metadata, parsed, messageRef),
        };
        const id = createHash("sha256")
          .update(`${mailbox}:${logicalFolder}:${uidValidity}:${uid}`)
          .digest("hex");
        await writeMailSnapshot(
          join(outputDirectory, `${id}.json`),
          snapshot,
        );
        stored += 1;
      }

      const lastUid = Math.max(
        currentLastUid,
        selectedUids.at(-1) ?? Number(previous?.last_uid ?? 0),
      );
      this.store.setImapState(mailbox, logicalFolder, uidValidity, lastUid);
      return {
        folder: logicalFolder,
        folderPath: path,
        changedMessages: stored,
        lastUid,
        uidValidity,
      };
    } finally {
      lock.release();
    }
  }

  async executeAction(action, approval) {
    assertImapActionAllowed(action.type, approval, this.config.mailActionMode);
    const credential = this.requiredCredential(action.mailbox);
    const folders = JSON.parse(credential.folders_json);
    const password = decryptToken(
      credential.password_encrypted,
      this.config.tokenEncryptionKey,
    );

    if (["send_mail", "reply", "reply_all", "forward"].includes(action.type)) {
      return this.sendAction(action, password, folders);
    }

    return this.withImapPassword(action.mailbox, password, async (client) => {
      switch (action.type) {
        case "create_draft": {
          const raw = await this.buildRaw(action.request.message, action.mailbox);
          const appended = await appendDraft(
            client,
            requiredFolder(folders.drafts, "Borradores"),
            raw.message,
          );
          if (!appended?.uid || !appended?.uidValidity) throw new Error("Draft saved without a usable reference; inspect Drafts before retrying");
          const lock = await client.getMailboxLock(folders.drafts, {readOnly:true});
          try {
            const check = await client.fetchOne(appended.uid, {source:true}, {uid:true});
            if (String(client.mailbox.uidValidity) !== String(appended.uidValidity) || !check?.source ||
                createHash("sha256").update(normalizeImapNewlines(check.source)).digest("hex") !==
                createHash("sha256").update(normalizeImapNewlines(raw.message)).digest("hex")) {
              throw new Error("Draft original readback mismatch; inspect Drafts before retrying");
            }
          } finally { lock.release(); }
          return {...appendResult(appended), messageId:encodeMessageRef(folders.drafts, appended.uidValidity, appended.uid), verified:true};
        }
        case "send_draft":
          return this.sendDraft(client, action, password, folders);
        case "update_message":
          return updateMessage(client, action.request, folders);
        case "move_message":
          return withMessage(client, action.request.messageId, async (ref) => {
            const destination = resolveFolder(
              action.request.destinationId,
              folders,
            );
            return serializeImapResult(
              await client.messageMove(ref.uid, destination, { uid: true }),
            );
          });
        case "delete_message":
          return withMessage(client, action.request.messageId, async (ref) =>
            serializeImapResult(await client.messageMove(
              ref.uid,
              requiredFolder(folders.trash, "Papelera"),
              { uid: true },
            )),
          );
        case "permanent_delete_message":
          return withMessage(client, action.request.messageId, async (ref) => ({
            deleted: await client.messageDelete(ref.uid, { uid: true }),
          }));
        case "add_attachment":
          return this.addAttachment(client, action.request, folders);
        case "create_folder":
          return serializeImapResult(
            await client.mailboxCreate(requiredText(
              action.request.folder?.displayName,
              "folder.displayName",
            )),
          );
        case "update_folder":
          return serializeImapResult(
            await client.mailboxRename(
              resolveFolder(action.request.folderId, folders),
              requiredText(
                action.request.changes?.displayName,
                "changes.displayName",
              ),
            ),
          );
        case "delete_folder":
          return serializeImapResult(
            await client.mailboxDelete(resolveFolder(
              action.request.folderId,
              folders,
            )),
          );
        case "update_mailbox_settings":
          throw publicError(
            "Este proveedor no permite cambiar la configuración general del buzón por IMAP",
            "MAILBOX_SETTINGS_UNSUPPORTED",
          );
        default:
          throw publicError(
            `Acción de correo no compatible: ${action.type}`,
            "MAIL_ACTION_UNSUPPORTED",
          );
      }
    });
  }

  async sendAction(action, password, folders) {
    let message = action.request.message;
    if (action.type !== "send_mail") {
      const original = await this.fetchParsedMessage(
        action.mailbox,
        password,
        action.request.messageId,
      );
      message = replyOrForwardMessage(action, original);
    }
    const raw = await this.buildRaw(message, action.mailbox);
    const transport = this.smtpTransport(action.mailbox, password);
    try {
      const sent = await transport.sendMail({
        envelope: raw.envelope,
        raw: smtpMessage(raw.message),
      });
      let sentCopy = { saved: false, fallbackWithoutFlags: false };
      try {
        sentCopy = await this.withImapPassword(
          action.mailbox,
          password,
          (client) => appendSent(client, folders.sent, raw.message),
        );
      } catch {
        // SMTP acceptance is the authoritative delivery result. A failure to
        // save the local copy must never turn an accepted send into a retryable
        // failure, because that could duplicate the email.
      }
      return {
        messageId: sent.messageId,
        accepted: sent.accepted,
        rejected: sent.rejected,
        response: sent.response,
        sentItemsSaved: sentCopy.saved,
        sentItemsFlagFallback: sentCopy.fallbackWithoutFlags,
      };
    } finally {
      transport.close();
    }
  }

  async sendDraft(client, action, password, folders) {
    const ref = decodeMessageRef(action.request.messageId);
    const lock = await client.getMailboxLock(ref.path);
    try {
      assertUidValidity(client, ref);
      const fetched = await client.fetchOne(ref.uid, { source: true }, { uid: true });
      if (!fetched?.source) throw publicError("No se encontró el borrador", "MESSAGE_NOT_FOUND");
      const parsed = await this.simpleParser(fetched.source);
      const transport = this.smtpTransport(action.mailbox, password);
      try {
        const sent = await transport.sendMail({
          envelope: {
            from: addressValue(parsed.from)?.[0]?.address ?? action.mailbox,
            to: [
              ...addressValue(parsed.to),
              ...addressValue(parsed.cc),
              ...addressValue(parsed.bcc),
            ].map((item) => item.address),
          },
          raw: smtpMessage(fetched.source),
        });
        const sentCopy = await appendSent(client, folders.sent, fetched.source);
        let draftDeleted = false;
        try {
          draftDeleted = Boolean(
            await client.messageDelete(ref.uid, { uid: true }),
          );
        } catch {
          // The message has already been accepted by SMTP. Do not report the
          // action as failed and invite a duplicate resend.
        }
        return {
          messageId: sent.messageId,
          accepted: sent.accepted,
          sentItemsSaved: sentCopy.saved,
          sentItemsFlagFallback: sentCopy.fallbackWithoutFlags,
          draftDeleted,
        };
      } finally {
        transport.close();
      }
    } finally {
      lock.release();
    }
  }

  async addAttachment(client, request, folders) {
    const ref = decodeMessageRef(request.messageId);
    const lock = await client.getMailboxLock(ref.path);
    try {
      assertUidValidity(client, ref);
      const fetched = await client.fetchOne(ref.uid, { source: true }, { uid: true });
      if (!fetched?.source) throw publicError("No se encontró el borrador", "MESSAGE_NOT_FOUND");
      const parsed = await this.simpleParser(fetched.source, { skipImageLinks: true });
      const attachment = request.attachment ?? {};
      const message = parsedToMessage(parsed);
      message.attachments = [
        ...(parsed.attachments ?? []).map((item) => ({
          filename: item.filename,
          contentType: item.contentType,
          contentId: item.contentId ?? item.cid,
          contentBytes: item.content.toString("base64"),
        })),
        attachment,
      ];
      const raw = await this.buildRaw(message, parsed.from?.value?.[0]?.address);
      const appended = await appendDraft(
        client,
        requiredFolder(folders.drafts, "Borradores"),
        raw.message,
      );
      await client.messageDelete(ref.uid, { uid: true });
      return appendResult(appended);
    } finally {
      lock.release();
    }
  }

  async fetchParsedMessage(mailbox, password, messageId) {
    return this.withImapPassword(mailbox, password, async (client) => {
      const ref = decodeMessageRef(messageId);
      const lock = await client.getMailboxLock(ref.path, { readOnly: true });
      try {
        assertUidValidity(client, ref);
        const fetched = await client.fetchOne(ref.uid, { source: true }, { uid: true });
        if (!fetched?.source) throw publicError("No se encontró el mensaje", "MESSAGE_NOT_FOUND");
        return this.simpleParser(fetched.source);
      } finally {
        lock.release();
      }
    });
  }

  async buildRaw(message, fallbackFrom) {
    if (!message || typeof message !== "object") {
      throw publicError("Falta el contenido del mensaje", "MESSAGE_REQUIRED");
    }
    const fields = graphMessageToNodemailer(message, fallbackFrom);
    const transport = this.nodemailer.createTransport({
      streamTransport: true,
      buffer: true,
      newline: "unix",
      keepBcc: true,
    });
    return transport.sendMail(fields);
  }

  smtpTransport(mailbox, password) {
    return this.nodemailer.createTransport({
      host: this.config.smtpHost,
      port: this.config.smtpPort,
      secure: this.config.smtpSecure,
      requireTLS: !this.config.smtpSecure,
      auth: { user: mailbox, pass: password },
      connectionTimeout: this.config.connectionTimeoutMs,
      greetingTimeout: this.config.connectionTimeoutMs,
      socketTimeout: this.config.connectionTimeoutMs,
      tls: { servername: this.config.smtpHost, minVersion: "TLSv1.2" },
    });
  }

  createImapPassword(mailbox, password) {
    const client = new this.ImapFlow({
      host: this.config.imapHost,
      port: this.config.imapPort,
      secure: true,
      auth: { user: mailbox, pass: password },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: this.config.connectionTimeoutMs,
      greetingTimeout: this.config.connectionTimeoutMs,
      socketTimeout: Math.max(this.config.connectionTimeoutMs * 2, 30_000),
      tls: { servername: this.config.imapHost, minVersion: "TLSv1.2" },
    });
    client.on("error", () => {});
    return client;
  }

  async withImapPassword(mailbox, password, callback) {
    const client = this.createImapPassword(mailbox,password);
    try {
      await client.connect();
      return await callback(client);
    } catch (error) {
      if (isAuthenticationError(error)) {
        throw publicError(
          "La contraseña no es correcta o el proveedor no permite el acceso",
          "MAIL_AUTHENTICATION_FAILED",
        );
      }
      throw error;
    } finally {
      if (client.usable) await client.logout().catch(() => {});
      else client.close();
    }
  }

  requiredCredential(mailbox) {
    const credential = this.store.mailCredential(mailbox);
    if (!credential) {
      throw publicError(`El buzón ${mailbox} todavía no está conectado`, "MAILBOX_NOT_CONNECTED");
    }
    return credential;
  }
}

export async function appendDraft(client, folder, message) {
  const imapSafeMessage = normalizeImapNewlines(message);
  try {
    return await client.append(folder, imapSafeMessage, ["\\Draft"]);
  } catch (error) {
    if (error?.responseStatus !== "NO") throw error;
    return client.append(folder, imapSafeMessage);
  }
}

export async function appendSent(client, folder, message) {
  if (!folder) return { saved: false, fallbackWithoutFlags: false };
  const imapSafeMessage = normalizeImapNewlines(message);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await client.append(folder, imapSafeMessage, ["\\Seen"]);
      return { saved: true, fallbackWithoutFlags: false };
    } catch {
      try {
        await client.append(folder, imapSafeMessage);
        return { saved: true, fallbackWithoutFlags: true };
      } catch {
        if (attempt < 2) await wait(300 * (attempt + 1));
      }
    }
  }
  return { saved: false, fallbackWithoutFlags: true };
}

function normalizeImapNewlines(message) {
  const buffer = Buffer.isBuffer(message) ? message : Buffer.from(message);
  return Buffer.from(
    buffer.toString("latin1").replace(/\r\n|\r|\n/g, "\r\n"),
    "latin1",
  );
}

export function assertImapActionAllowed(type, approval, mode = "review_only") {
  if (mode === "review_only") {
    const error = new Error(`Mailbox mutation blocked in review_only: ${type}`);
    error.code = "OUTLOOK_MAIL_ACTION_BLOCKED";
    throw error;
  }
  if (
    mode === "approval_required" &&
    !(
      approval?.confirmed === true &&
      typeof approval.id === "string" &&
      approval.id.trim().length >= 8 &&
      typeof approval.approvedBy === "string" &&
      approval.approvedBy.trim().length >= 2
    )
  ) {
    const error = new Error("Mailbox mutation requires a confirmed per-action approval");
    error.code = "OUTLOOK_MAIL_APPROVAL_REQUIRED";
    throw error;
  }
}

export function encodeMessageRef(path, uidValidity, uid) {
  return [
    "imap",
    Buffer.from(String(path), "utf8").toString("base64url"),
    String(uidValidity),
    String(uid),
  ].join(":");
}

export function decodeMessageRef(value) {
  const [kind, encodedPath, uidValidity, uidValue, extra] =
    String(value ?? "").split(":");
  const uid = Number(uidValue);
  if (
    kind !== "imap" ||
    !encodedPath ||
    !/^\d+$/.test(uidValidity ?? "") ||
    !Number.isSafeInteger(uid) ||
    uid < 1 ||
    extra
  ) {
    throw publicError("Referencia de mensaje no válida", "INVALID_MESSAGE_REFERENCE");
  }
  return {
    path: Buffer.from(encodedPath, "base64url").toString("utf8"),
    uidValidity,
    uid,
  };
}

function folderMap(listed) {
  const bySpecialUse = new Map(
    listed.filter((item) => item.specialUse).map((item) => [item.specialUse, item.path]),
  );
  const byName = (patterns) =>
    listed.find((item) => patterns.some((pattern) => pattern.test(item.path)))?.path ?? null;
  return {
    inbox: bySpecialUse.get("\\Inbox") ?? "INBOX",
    sent: bySpecialUse.get("\\Sent") ??
      byName([/(^|[/. ])sent($|[/. ])/i, /enviad/i]),
    drafts: bySpecialUse.get("\\Drafts") ?? byName([/draft/i, /borrador/i]),
    trash: bySpecialUse.get("\\Trash") ??
      byName([/trash/i, /deleted/i, /papelera/i, /eliminad/i]),
    archive: bySpecialUse.get("\\Archive") ?? byName([/archive/i, /archivo/i]),
    junk: bySpecialUse.get("\\Junk") ?? byName([/junk/i, /spam/i, /correo no deseado/i]),
  };
}

function normalizeMessage(metadata, parsed, messageRef) {
  return {
    id: messageRef,
    uid: Number(metadata.uid),
    subject: parsed?.subject ?? metadata.envelope?.subject ?? "",
    from: parsed ? addressValue(parsed.from) : envelopeAddresses(metadata.envelope?.from),
    toRecipients: parsed ? addressValue(parsed.to) : envelopeAddresses(metadata.envelope?.to),
    ccRecipients: parsed ? addressValue(parsed.cc) : envelopeAddresses(metadata.envelope?.cc),
    bccRecipients: parsed ? addressValue(parsed.bcc) : envelopeAddresses(metadata.envelope?.bcc),
    replyTo: parsed ? addressValue(parsed.replyTo) : envelopeAddresses(metadata.envelope?.replyTo),
    receivedDateTime: (metadata.internalDate ?? metadata.envelope?.date)?.toISOString?.() ?? null,
    sentDateTime: parsed?.date?.toISOString?.() ?? metadata.envelope?.date?.toISOString?.() ?? null,
    internetMessageId: parsed?.messageId ?? metadata.envelope?.messageId ?? null,
    inReplyTo: parsed?.inReplyTo ?? null,
    references: parsed?.references ?? [],
    flags: [...(metadata.flags ?? [])],
    isRead: metadata.flags?.has?.("\\Seen") ?? false,
    hasAttachments: Boolean(parsed?.attachments?.length),
    attachments: (parsed?.attachments ?? []).map((item) => ({
      filename: item.filename ?? null,
      contentType: item.contentType ?? null,
      size: item.size ?? item.content?.length ?? null,
      contentId: item.contentId ?? null,
    })),
    text: truncate(parsed?.text ?? "", 200_000),
    html: truncate(typeof parsed?.html === "string" ? parsed.html : "", 400_000),
    size: Number(metadata.size ?? 0),
    bodyFetched: Boolean(parsed),
  };
}

function graphMessageToNodemailer(message, fallbackFrom) {
  const body = message.body ?? {};
  return {
    from: formatMailbox(message.from?.emailAddress) || fallbackFrom,
    to: formatRecipients(message.toRecipients),
    cc: formatRecipients(message.ccRecipients),
    bcc: formatRecipients(message.bccRecipients),
    replyTo: formatRecipients(message.replyTo),
    subject: String(message.subject ?? ""),
    messageId: message.internetMessageId || undefined,
    ...(String(body.contentType ?? "text").toLowerCase() === "html"
      ? { html: String(body.content ?? "") }
      : { text: String(body.content ?? "") }),
    headers: {
      ...(message.internetMessageHeaders
        ? Object.fromEntries(message.internetMessageHeaders.map((item) => [item.name, item.value]))
        : {}),
      ...(message.inReplyTo ? { "In-Reply-To": message.inReplyTo } : {}),
      ...(message.references ? { References: [].concat(message.references).join(" ") } : {}),
    },
    attachments: (message.attachments ?? []).map((item) => ({
      filename: item.name ?? item.filename,
      content: Buffer.from(item.contentBytes ?? item.content ?? "", "base64"),
      contentType: item.contentType,
      cid: item.contentId,
      // Nodemailer defaults RFC822 parts to inline, which makes readers merge
      // their body into the outer message. An ordinary attached original must
      // remain a file; explicitly inline parts and CID signatures keep theirs.
      ...(String(item.contentType ?? "").toLowerCase() === "message/rfc822"
        ? item.isInline || item.contentId
          ? { contentDisposition: "inline" }
          // Encoding protects original CR/LF bytes from transport normalization.
          : { contentDisposition: "attachment", contentTransferEncoding: "base64" }
        : {}),
    })),
  };
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function replyOrForwardMessage(action, original) {
  const own = action.mailbox.toLowerCase();
  const from = addressValue(original.from);
  const replyTo = addressValue(original.replyTo);
  const originalTo = addressValue(original.to);
  const originalCc = addressValue(original.cc);
  const baseRecipients = replyTo.length ? replyTo : from;
  const requestMessage = action.request.message ?? {};
  const comment = action.request.comment ?? requestMessage.body?.content ?? "";
  const isHtml = String(requestMessage.body?.contentType ?? "text").toLowerCase() === "html";
  const references = [
    ...(Array.isArray(original.references) ? original.references : []),
    original.messageId,
  ].filter(Boolean);

  if (action.type === "forward") {
    return {
      ...requestMessage,
      subject: requestMessage.subject ?? `Fwd: ${original.subject ?? ""}`,
      attachments: [
        ...(original.attachments ?? []).map((item) => ({name: item.filename, contentType: item.contentType, contentId: item.contentId, contentBytes: item.content.toString("base64")})),
        ...(requestMessage.attachments ?? []),
      ],
      toRecipients: action.request.toRecipients ?? requestMessage.toRecipients,
      body: {
        contentType: isHtml ? "html" : "text",
        content: `${comment}${isHtml ? "<hr>" : "\n\n---\n"}${isHtml
          ? (typeof original.html === "string" ? original.html : escapeHtml(original.text ?? ""))
          : (original.text ?? "")}`,
      },
    };
  }

  const replyAll = action.type === "reply_all"
    ? dedupeAddresses([...baseRecipients, ...originalTo, ...originalCc], own)
    : dedupeAddresses(baseRecipients, own);
  return {
    ...requestMessage,
    subject: requestMessage.subject ??
      (/^re:/i.test(original.subject ?? "") ? original.subject : `Re: ${original.subject ?? ""}`),
    toRecipients: replyAll.map(toGraphRecipient),
    body: {
      contentType: isHtml ? "html" : "text",
      content: String(comment),
    },
    inReplyTo: original.messageId,
    references,
  };
}

async function updateMessage(client, request, folders) {
  return withMessage(client, request.messageId, async (ref) => {
    const changes = request.changes ?? {};
    if ("isRead" in changes) {
      const method = changes.isRead ? "messageFlagsAdd" : "messageFlagsRemove";
      await client[method](ref.uid, ["\\Seen"], { uid: true });
    }
    if ("flag" in changes) {
      const flagged =
        changes.flag?.flagStatus === "flagged" || changes.flag === true;
      const method = flagged ? "messageFlagsAdd" : "messageFlagsRemove";
      await client[method](ref.uid, ["\\Flagged"], { uid: true });
    }
    if (changes.destinationId) {
      await client.messageMove(
        ref.uid,
        resolveFolder(changes.destinationId, folders),
        { uid: true },
      );
    }
    return { updated: true };
  });
}

async function withMessage(client, messageId, callback) {
  const ref = decodeMessageRef(messageId);
  const lock = await client.getMailboxLock(ref.path);
  try {
    assertUidValidity(client, ref);
    return await callback(ref);
  } finally {
    lock.release();
  }
}

function assertUidValidity(client, ref) {
  if (String(client.mailbox.uidValidity) !== ref.uidValidity) {
    throw publicError(
      "El buzón ha cambiado y hay que volver a localizar el mensaje",
      "MESSAGE_REFERENCE_EXPIRED",
    );
  }
}

function resolveFolder(value, folders) {
  const key = String(value ?? "").toLowerCase();
  const aliases = {
    inbox: folders.inbox,
    sentitems: folders.sent,
    sent: folders.sent,
    drafts: folders.drafts,
    deleteditems: folders.trash,
    trash: folders.trash,
    archive: folders.archive,
    junkemail: folders.junk,
    junk: folders.junk,
  };
  return requiredFolder(aliases[key] ?? String(value ?? "").trim(), "destino");
}

function requiredFolder(value, label) {
  if (!value) throw publicError(`No se encontró la carpeta ${label}`, "MAIL_FOLDER_NOT_FOUND");
  return value;
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw publicError(`Falta ${label}`, "MAIL_ACTION_INVALID");
  }
  return value.trim();
}

function parsedToMessage(parsed) {
  return {
    subject: parsed.subject,
    from: { emailAddress: addressValue(parsed.from)[0] },
    toRecipients: addressValue(parsed.to).map(toGraphRecipient),
    ccRecipients: addressValue(parsed.cc).map(toGraphRecipient),
    bccRecipients: addressValue(parsed.bcc).map(toGraphRecipient),
    body: parsed.html
      ? { contentType: "html", content: String(parsed.html) }
      : { contentType: "text", content: parsed.text ?? "" },
  };
}

function envelopeAddresses(values = []) {
  return values.map((item) => ({
    name: item.name ?? "",
    address: [item.mailbox, item.host].filter(Boolean).join("@"),
  })).filter((item) => item.address.includes("@"));
}

function addressValue(value) {
  return value?.value?.map((item) => ({
    name: item.name ?? "",
    address: item.address ?? "",
  })).filter((item) => item.address) ?? [];
}

function formatMailbox(value) {
  if (!value?.address) return "";
  return value.name ? { name: value.name, address: value.address } : value.address;
}

function formatRecipients(values) {
  if (values == null) return [];
  if (!Array.isArray(values)) throw new Error("Recipients must be an array");
  return values.map((item) => {
    const mailbox = typeof item === "string" ? { address: item.trim() } : item?.emailAddress ?? item;
    if (!mailbox || typeof mailbox.address !== "string" ||
        !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(mailbox.address) ||
        (mailbox.name != null && (typeof mailbox.name !== "string" || /[\r\n]/.test(mailbox.name)))) {
      throw new Error("Invalid recipient; no address may be silently omitted");
    }
    return formatMailbox(mailbox);
  });
}

function toGraphRecipient(item) {
  return { emailAddress: { name: item.name ?? "", address: item.address } };
}

function dedupeAddresses(values, excludedAddress) {
  const seen = new Set();
  return values.filter((item) => {
    const key = String(item.address ?? "").toLowerCase();
    if (!key || key === excludedAddress || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function appendResult(result) {
  if (!result) return { appended: false };
  return {
    appended: true,
    path: result.path ?? result.destination ?? null,
    uid: result.uid ? Number(result.uid) : null,
    uidValidity: result.uidValidity ? String(result.uidValidity) : null,
  };
}

function serializeImapResult(value) {
  if (value instanceof Map) return Object.fromEntries(value);
  if (typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return value.map(serializeImapResult);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, serializeImapResult(item)]),
    );
  }
  return value;
}

function isAuthenticationError(error) {
  const text = `${error?.authenticationFailed ?? ""} ${error?.responseText ?? ""} ${error?.message ?? ""}`;
  return error?.authenticationFailed || /auth|login|password|credential/i.test(text);
}

function publicError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.publicMessage = message;
  return error;
}

function truncate(value, limit) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}\n[contenido truncado]` : text;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
