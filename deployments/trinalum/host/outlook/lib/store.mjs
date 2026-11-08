import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class OutlookStore {
  constructor(databasePath) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        notification_id TEXT PRIMARY KEY,
        subscription_id TEXT NOT NULL,
        change_type TEXT NOT NULL,
        resource TEXT NOT NULL,
        resource_data_json TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        received_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        processed_at TEXT,
        snapshot_path TEXT
      );
      CREATE INDEX IF NOT EXISTS notifications_queue_idx
        ON notifications(status, received_at);

      CREATE TABLE IF NOT EXISTS subscriptions (
        subscription_id TEXT PRIMARY KEY,
        mailbox TEXT NOT NULL,
        folder TEXT NOT NULL,
        resource TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_scope_idx
        ON subscriptions(mailbox, folder);

      CREATE TABLE IF NOT EXISTS delta_state (
        mailbox TEXT NOT NULL,
        folder TEXT NOT NULL,
        delta_link TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(mailbox, folder)
      );

      CREATE TABLE IF NOT EXISTS oauth_states (
        state_hash TEXT PRIMARY KEY,
        mailbox TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS oauth_states_expiry_idx
        ON oauth_states(expires_at);

      CREATE TABLE IF NOT EXISTS oauth_accounts (
        mailbox TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        tenant_id TEXT,
        microsoft_user_id TEXT NOT NULL,
        principal TEXT NOT NULL,
        display_name TEXT,
        refresh_token_encrypted TEXT NOT NULL,
        scope TEXT,
        connected_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS credential_states (
        state_hash TEXT PRIMARY KEY,
        mailbox TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS credential_states_expiry_idx
        ON credential_states(expires_at);

      CREATE TABLE IF NOT EXISTS mail_credentials (
        mailbox TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        password_encrypted TEXT NOT NULL,
        folders_json TEXT NOT NULL,
        connected_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_verified_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS imap_state (
        mailbox TEXT NOT NULL,
        folder TEXT NOT NULL,
        uid_validity TEXT NOT NULL,
        last_uid INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(mailbox, folder)
      );

      CREATE TABLE IF NOT EXISTS mail_actions (
        action_id TEXT PRIMARY KEY,
        mailbox TEXT NOT NULL,
        action_type TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        request_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'prepared',
        requested_by TEXT,
        approved_by TEXT,
        created_at TEXT NOT NULL,
        approved_at TEXT,
        executed_at TEXT,
        result_json TEXT,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS mail_actions_status_idx
        ON mail_actions(status, created_at);
    `);
  }

  enqueue(notification) {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO notifications (
        notification_id, subscription_id, change_type, resource,
        resource_data_json, payload_json, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      notification.id,
      notification.subscriptionId,
      notification.changeType,
      notification.resource,
      JSON.stringify(notification.resourceData),
      JSON.stringify(notification.payload),
      new Date().toISOString(),
    );
    return result.changes === 1;
  }

  nextPending() {
    return this.db.prepare(`
      SELECT * FROM notifications
      WHERE status IN ('pending', 'retry') AND attempts < 8
      ORDER BY received_at
      LIMIT 1
    `).get();
  }

  claim(id) {
    return this.db.prepare(`
      UPDATE notifications
      SET status = 'processing', attempts = attempts + 1, last_error = NULL
      WHERE notification_id = ? AND status IN ('pending', 'retry')
    `).run(id).changes === 1;
  }

  complete(id, snapshotPath) {
    this.db.prepare(`
      UPDATE notifications
      SET status = 'processed', processed_at = ?, snapshot_path = ?, last_error = NULL
      WHERE notification_id = ?
    `).run(new Date().toISOString(), snapshotPath, id);
  }

  fail(id, error) {
    this.db.prepare(`
      UPDATE notifications
      SET status = CASE WHEN attempts >= 8 THEN 'failed' ELSE 'retry' END,
          last_error = ?
      WHERE notification_id = ?
    `).run(String(error?.message ?? error).slice(0, 2000), id);
  }

  upsertSubscription(subscription, mailbox, folder) {
    this.db.prepare(`
      INSERT INTO subscriptions (
        subscription_id, mailbox, folder, resource, expires_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(mailbox, folder) DO UPDATE SET
        subscription_id = excluded.subscription_id,
        resource = excluded.resource,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `).run(
      subscription.id,
      mailbox,
      folder,
      subscription.resource,
      subscription.expirationDateTime,
      new Date().toISOString(),
    );
  }

  subscription(mailbox, folder) {
    return this.db.prepare(
      `SELECT * FROM subscriptions WHERE mailbox = ? AND folder = ?`,
    ).get(mailbox, folder);
  }

  subscriptionById(subscriptionId) {
    return this.db.prepare(
      `SELECT * FROM subscriptions WHERE subscription_id = ?`,
    ).get(subscriptionId);
  }

  subscriptions() {
    return this.db.prepare(`SELECT * FROM subscriptions ORDER BY mailbox, folder`).all();
  }

  getDeltaLink(mailbox, folder) {
    return this.db.prepare(
      `SELECT delta_link FROM delta_state WHERE mailbox = ? AND folder = ?`,
    ).get(mailbox, folder)?.delta_link ?? null;
  }

  setDeltaLink(mailbox, folder, deltaLink) {
    this.db.prepare(`
      INSERT INTO delta_state(mailbox, folder, delta_link, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(mailbox, folder) DO UPDATE SET
        delta_link = excluded.delta_link,
        updated_at = excluded.updated_at
    `).run(mailbox, folder, deltaLink, new Date().toISOString());
  }

  createOAuthState(state, mailbox, ttlMs = 10 * 60 * 1000) {
    const now = new Date();
    this.db.prepare(`DELETE FROM oauth_states WHERE expires_at <= ?`)
      .run(now.toISOString());
    this.db.prepare(`DELETE FROM oauth_states WHERE mailbox = ?`).run(mailbox);
    this.db.prepare(`
      INSERT INTO oauth_states(state_hash, mailbox, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(
      hashState(state),
      mailbox,
      now.toISOString(),
      new Date(now.getTime() + ttlMs).toISOString(),
    );
  }

  consumeOAuthState(state) {
    const hash = hashState(state);
    const row = this.db.prepare(`
      SELECT state_hash, mailbox, created_at, expires_at
      FROM oauth_states
      WHERE state_hash = ? AND expires_at > ?
    `).get(hash, new Date().toISOString());
    this.db.prepare(`DELETE FROM oauth_states WHERE state_hash = ?`).run(hash);
    return row ?? null;
  }

  upsertOAuthAccount(account) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO oauth_accounts(
        mailbox, owner, tenant_id, microsoft_user_id, principal, display_name,
        refresh_token_encrypted, scope, connected_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(mailbox) DO UPDATE SET
        owner = excluded.owner,
        tenant_id = excluded.tenant_id,
        microsoft_user_id = excluded.microsoft_user_id,
        principal = excluded.principal,
        display_name = excluded.display_name,
        refresh_token_encrypted = excluded.refresh_token_encrypted,
        scope = excluded.scope,
        updated_at = excluded.updated_at
    `).run(
      account.mailbox,
      account.owner,
      account.tenantId ?? null,
      account.microsoftUserId,
      account.principal,
      account.displayName ?? null,
      account.refreshTokenEncrypted,
      account.scope ?? null,
      now,
      now,
    );
  }

  oauthAccount(mailbox) {
    return this.db.prepare(
      `SELECT * FROM oauth_accounts WHERE mailbox = ?`,
    ).get(mailbox);
  }

  updateOAuthRefreshToken(mailbox, refreshTokenEncrypted, scope = null) {
    const result = this.db.prepare(`
      UPDATE oauth_accounts
      SET refresh_token_encrypted = ?,
          scope = COALESCE(?, scope),
          updated_at = ?
      WHERE mailbox = ?
    `).run(
      refreshTokenEncrypted,
      scope,
      new Date().toISOString(),
      mailbox,
    );
    if (result.changes !== 1) throw new Error(`OAuth account not found for ${mailbox}`);
  }

  oauthAccounts() {
    return this.db.prepare(`
      SELECT mailbox, owner, tenant_id, microsoft_user_id, principal,
             display_name, scope, connected_at, updated_at
      FROM oauth_accounts
      ORDER BY owner
    `).all();
  }

  createCredentialState(state, mailbox, ttlMs = 10 * 60 * 1000) {
    const now = new Date();
    this.db.prepare(`DELETE FROM credential_states WHERE expires_at <= ?`)
      .run(now.toISOString());
    this.db.prepare(`DELETE FROM credential_states WHERE mailbox = ?`).run(mailbox);
    this.db.prepare(`
      INSERT INTO credential_states(state_hash, mailbox, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(
      hashState(state),
      mailbox,
      now.toISOString(),
      new Date(now.getTime() + ttlMs).toISOString(),
    );
  }

  consumeCredentialState(state, mailbox) {
    const hash = hashState(state);
    const row = this.db.prepare(`
      SELECT state_hash, mailbox, created_at, expires_at
      FROM credential_states
      WHERE state_hash = ? AND mailbox = ? AND expires_at > ?
    `).get(hash, mailbox, new Date().toISOString());
    this.db.prepare(`DELETE FROM credential_states WHERE state_hash = ?`).run(hash);
    return row ?? null;
  }

  upsertMailCredential(account) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO mail_credentials(
        mailbox, owner, password_encrypted, folders_json,
        connected_at, updated_at, last_verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(mailbox) DO UPDATE SET
        owner = excluded.owner,
        password_encrypted = excluded.password_encrypted,
        folders_json = excluded.folders_json,
        updated_at = excluded.updated_at,
        last_verified_at = excluded.last_verified_at
    `).run(
      account.mailbox,
      account.owner,
      account.passwordEncrypted,
      JSON.stringify(account.folders ?? {}),
      now,
      now,
      now,
    );
  }

  mailCredential(mailbox) {
    return this.db.prepare(`
      SELECT mailbox, owner, password_encrypted, folders_json,
             connected_at, updated_at, last_verified_at
      FROM mail_credentials
      WHERE mailbox = ?
    `).get(mailbox);
  }

  mailCredentials() {
    return this.db.prepare(`
      SELECT mailbox, owner, folders_json, connected_at, updated_at, last_verified_at
      FROM mail_credentials
      ORDER BY owner
    `).all();
  }

  getImapState(mailbox, folder) {
    return this.db.prepare(`
      SELECT mailbox, folder, uid_validity, last_uid, updated_at
      FROM imap_state
      WHERE mailbox = ? AND folder = ?
    `).get(mailbox, folder) ?? null;
  }

  setImapState(mailbox, folder, uidValidity, lastUid) {
    this.db.prepare(`
      INSERT INTO imap_state(mailbox, folder, uid_validity, last_uid, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(mailbox, folder) DO UPDATE SET
        uid_validity = excluded.uid_validity,
        last_uid = excluded.last_uid,
        updated_at = excluded.updated_at
    `).run(
      mailbox,
      folder,
      String(uidValidity),
      Number(lastUid),
      new Date().toISOString(),
    );
  }

  prepareMailAction(action) {
    const requestJson = stableJson(action.request);
    const requestHash = createHash("sha256").update(requestJson).digest("hex");
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR IGNORE INTO mail_actions(
        action_id, mailbox, action_type, request_hash, request_json,
        requested_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      action.id,
      action.mailbox,
      action.type,
      requestHash,
      requestJson,
      action.requestedBy ?? null,
      now,
    );
    const stored = this.mailAction(action.id);
    if (
      stored.mailbox !== action.mailbox ||
      stored.action_type !== action.type ||
      stored.request_hash !== requestHash
    ) {
      throw new Error(
        `Mail action ${action.id} already exists with different exact content`,
      );
    }
    return stored;
  }

  mailAction(actionId) {
    return this.db.prepare(
      `SELECT * FROM mail_actions WHERE action_id = ?`,
    ).get(actionId);
  }

  approveMailAction(actionId, approvedBy) {
    const result = this.db.prepare(`
      UPDATE mail_actions
      SET status = 'approved',
          approved_by = ?,
          approved_at = ?,
          last_error = NULL
      WHERE action_id = ?
        AND status IN ('prepared', 'approved', 'failed')
    `).run(approvedBy, new Date().toISOString(), actionId);
    if (result.changes !== 1) {
      const existing = this.mailAction(actionId);
      if (existing?.status === "completed") return existing;
      throw new Error(`Mail action ${actionId} is not ready for approval`);
    }
    return this.mailAction(actionId);
  }

  claimMailAction(actionId) {
    return this.db.prepare(`
      UPDATE mail_actions
      SET status = 'executing', last_error = NULL
      WHERE action_id = ? AND status = 'approved'
    `).run(actionId).changes === 1;
  }

  completeMailAction(actionId, result) {
    this.db.prepare(`
      UPDATE mail_actions
      SET status = 'completed',
          executed_at = ?,
          result_json = ?,
          last_error = NULL
      WHERE action_id = ? AND status = 'executing'
    `).run(
      new Date().toISOString(),
      JSON.stringify(result ?? null),
      actionId,
    );
  }

  failMailAction(actionId, error) {
    this.db.prepare(`
      UPDATE mail_actions
      SET status = 'failed',
          last_error = ?
      WHERE action_id = ? AND status = 'executing'
    `).run(String(error?.message ?? error).slice(0, 2000), actionId);
  }

  cancelMailAction(actionId, reason) {
    const result = this.db.prepare(`
      UPDATE mail_actions
      SET status = 'cancelled',
          last_error = ?
      WHERE action_id = ? AND status IN ('prepared', 'approved', 'failed')
    `).run(String(reason).slice(0, 2000), actionId);
    if (result.changes !== 1) {
      throw new Error(`Mail action ${actionId} cannot be cancelled`);
    }
    return this.mailAction(actionId);
  }

  stats() {
    const rows = this.db.prepare(
      `SELECT status, COUNT(*) AS count FROM notifications GROUP BY status`,
    ).all();
    return {
      notifications: Object.fromEntries(rows.map((row) => [row.status, Number(row.count)])),
      subscriptions: this.subscriptions().map((row) => ({
        mailbox: row.mailbox,
        folder: row.folder,
        expiresAt: row.expires_at,
      })),
      oauthAccounts: this.oauthAccounts().map((row) => ({
        mailbox: row.mailbox,
        owner: row.owner,
        principal: row.principal,
        connectedAt: row.connected_at,
        updatedAt: row.updated_at,
      })),
      mailCredentials: this.mailCredentials().map((row) => ({
        mailbox: row.mailbox,
        owner: row.owner,
        connectedAt: row.connected_at,
        updatedAt: row.updated_at,
        lastVerifiedAt: row.last_verified_at,
      })),
      mailActions: Object.fromEntries(
        this.db.prepare(
          `SELECT status, COUNT(*) AS count FROM mail_actions GROUP BY status`,
        ).all().map((row) => [row.status, Number(row.count)]),
      ),
    };
  }

  close() {
    this.db.close();
  }
}

function hashState(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${stableJson(value[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}
