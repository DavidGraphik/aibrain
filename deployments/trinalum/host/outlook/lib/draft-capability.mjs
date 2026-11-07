// Capability checks never connect, append a message or send through SMTP.
export function assertDraftCapability(config, store, mailbox) {
  if (config.provider !== "imap_smtp") return;
  const credential = store.mailCredential(mailbox);
  if (!credential || credential.mailbox !== mailbox) {
    throw Object.assign(new Error("The selected mailbox is not connected"), {code: "MAILBOX_NOT_CONNECTED"});
  }
  let folders;
  try { folders = JSON.parse(credential.folders_json); } catch { folders = null; }
  if (!folders || typeof folders.drafts !== "string" || !folders.drafts.trim()) {
    throw Object.assign(new Error("The selected mailbox has no verified Drafts folder; keep the proposed email in the review card"), {code: "MAIL_DRAFTS_FOLDER_UNAVAILABLE"});
  }
}
