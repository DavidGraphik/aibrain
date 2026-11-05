export function outlookConfig(env = process.env) {
  const provider =
    env.OUTLOOK_PROVIDER?.trim().toLowerCase() || "microsoft_graph";
  if (!["microsoft_graph", "imap_smtp"].includes(provider)) {
    throw new Error("OUTLOOK_PROVIDER must be microsoft_graph or imap_smtp");
  }
  const authMode = provider === "imap_smtp"
    ? "password"
    : (env.OUTLOOK_AUTH_MODE?.trim().toLowerCase() || "application");
  if (provider === "microsoft_graph" && !["application", "delegated"].includes(authMode)) {
    throw new Error("OUTLOOK_AUTH_MODE must be application or delegated");
  }
  const mailActionMode =
    env.OUTLOOK_MAIL_ACTION_MODE?.trim().toLowerCase() || "review_only";
  if (!["review_only", "approval_required", "autonomous"].includes(mailActionMode)) {
    throw new Error(
      "OUTLOOK_MAIL_ACTION_MODE must be review_only, approval_required or autonomous",
    );
  }

  const config = {
    provider,
    operatorName: env.OUTLOOK_OPERATOR_NAME?.trim() || null,
    signaturesFile: env.OUTLOOK_SIGNATURES_FILE?.trim() || null,
    authMode,
    mailActionMode,
    mailboxes: parseMailboxes(required(env, "OUTLOOK_MAILBOXES_JSON")),
    dataDirectory: env.OUTLOOK_DATA_DIR?.trim() || "/var/lib/aibrain/mail",
    bind: env.OUTLOOK_WEBHOOK_BIND?.trim() || "127.0.0.1",
    port: Number(env.OUTLOOK_WEBHOOK_PORT || 18911),
  };

  if (provider === "imap_smtp") {
    config.imapHost = required(env, "OUTLOOK_IMAP_HOST");
    config.imapPort = validPort(env.OUTLOOK_IMAP_PORT || 993, "OUTLOOK_IMAP_PORT");
    config.smtpHost = required(env, "OUTLOOK_SMTP_HOST");
    config.smtpPort = validPort(env.OUTLOOK_SMTP_PORT || 465, "OUTLOOK_SMTP_PORT");
    config.smtpSecure = booleanValue(
      env.OUTLOOK_SMTP_SECURE,
      config.smtpPort === 465,
      "OUTLOOK_SMTP_SECURE",
    );
    config.connectionTimeoutMs = positiveNumber(
      env.OUTLOOK_CONNECTION_TIMEOUT_MS || 12_000,
      "OUTLOOK_CONNECTION_TIMEOUT_MS",
    );
    config.initialSyncLimit = positiveNumber(
      env.OUTLOOK_INITIAL_SYNC_LIMIT || 200,
      "OUTLOOK_INITIAL_SYNC_LIMIT",
    );
    config.maxMessageBytes = positiveNumber(
      env.OUTLOOK_MAX_MESSAGE_BYTES || 8_000_000,
      "OUTLOOK_MAX_MESSAGE_BYTES",
    );
    config.tokenEncryptionKey = required(env, "OUTLOOK_TOKEN_ENCRYPTION_KEY", 32);
  } else {
    config.tenantId = authMode === "delegated"
      ? (env.OUTLOOK_TENANT_ID?.trim() || "organizations")
      : required(env, "OUTLOOK_TENANT_ID");
    config.clientId = required(env, "OUTLOOK_CLIENT_ID");
    config.clientSecret = required(env, "OUTLOOK_CLIENT_SECRET");
    config.clientState = required(env, "OUTLOOK_CLIENT_STATE", 32);
    config.notificationUrl = required(env, "OUTLOOK_NOTIFICATION_URL");
    config.lifecycleNotificationUrl =
      env.OUTLOOK_LIFECYCLE_NOTIFICATION_URL?.trim() || null;
    if (authMode === "delegated") {
      config.oauthRedirectUrl = required(env, "OUTLOOK_OAUTH_REDIRECT_URL");
      config.tokenEncryptionKey = required(env, "OUTLOOK_TOKEN_ENCRYPTION_KEY", 32);
    }
  }

  return config;
}

export function parseMailboxes(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("OUTLOOK_MAILBOXES_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 100) throw new Error("OUTLOOK_MAILBOXES_JSON must contain 1 to 100 mailbox bindings");
  const names=new Set(),addresses=new Set();
  for(const mailbox of parsed){
    const name=String(mailbox?.name??'').trim().toLowerCase(),address=String(mailbox?.address??'').trim().toLowerCase(),login=String(mailbox?.loginAddress??address).trim().toLowerCase();
    const valid=value=>/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)&&value.length<=320;
    if(!name||name.length>100||/[\x00-\x1f\x7f]/.test(name)||!valid(address)||!valid(login)||names.has(name)||addresses.has(address))throw new Error("Each mailbox requires a unique name/address and a valid login address");
    names.add(name);addresses.add(address);
  }
  return parsed.map((mailbox) => ({
    name: String(mailbox.name).trim(),
    address: String(mailbox.address).trim().toLowerCase(),
    loginAddress: String(mailbox.loginAddress ?? mailbox.address).trim().toLowerCase(),
  }));
}

function required(env, name, minLength = 1) {
  const value = env[name]?.trim();
  if (!value || value.length < minLength) throw new Error(`${name} is required`);
  return value;
}

function validPort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return port;
}

function positiveNumber(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return number;
}

function booleanValue(value, fallback, name) {
  if (value == null || String(value).trim() === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes"].includes(normalized)) return true;
  if (["0", "false", "no"].includes(normalized)) return false;
  throw new Error(`${name} must be true or false`);
}
