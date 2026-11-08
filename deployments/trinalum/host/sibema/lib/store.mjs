import { mkdirSync, readFileSync, readlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class SibemaStore {
  constructor(databasePath) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        object_type TEXT NOT NULL,
        object_id TEXT NOT NULL,
        related_json TEXT NOT NULL,
        changed_fields_json TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        received_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        processed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS events_status_received_idx
        ON events(status, received_at);

      CREATE TABLE IF NOT EXISTS snapshots (
        event_id TEXT PRIMARY KEY REFERENCES events(event_id),
        resource_type TEXT NOT NULL,
        object_id TEXT NOT NULL,
        snapshot_path TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS review_tasks (
        task_id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id),
        workflow TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ready',
        output_path TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        resource_type TEXT PRIMARY KEY,
        cursor TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS approved_actions (
        action_id TEXT PRIMARY KEY,
        action_type TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        request_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'prepared',
        requested_by TEXT NOT NULL,
        approved_by TEXT,
        created_at TEXT NOT NULL,
        approved_at TEXT,
        executed_at TEXT,
        result_json TEXT,
        readback_json TEXT,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS order_pdf_order_fences (
        order_id INTEGER PRIMARY KEY, action_id TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('checking','dispatch')),
        boot_id TEXT NOT NULL, pid INTEGER NOT NULL, start_ticks TEXT NOT NULL, pid_namespace TEXT NOT NULL, claimed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS order_pdf_fence_recoveries (
        recovery_id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, old_action_id TEXT NOT NULL, new_action_id TEXT NOT NULL,
        old_phase TEXT NOT NULL, old_boot_id TEXT NOT NULL, old_pid INTEGER NOT NULL, old_start_ticks TEXT NOT NULL,
        old_pid_namespace TEXT NOT NULL, reason TEXT NOT NULL, recovered_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS order_pdf_resource_fences (
        resource_sha256 TEXT PRIMARY KEY, action_id TEXT NOT NULL,
        claimed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deletion_resource_fences (
        integration TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('tariff','offer')),
        customer_id INTEGER NOT NULL,
        target_id INTEGER NOT NULL,
        action_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        snapshot_sha256 TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('dispatch','completed','rejected','uncertain')),
        claimed_at TEXT NOT NULL,
        finished_at TEXT,
        PRIMARY KEY(integration,kind,customer_id,target_id)
      );
      CREATE INDEX IF NOT EXISTS approved_actions_status_idx
        ON approved_actions(status, created_at);
      CREATE TABLE IF NOT EXISTS deletion_recovery_grants (
        grant_id TEXT PRIMARY KEY, integration TEXT NOT NULL, kind TEXT NOT NULL,
        customer_id INTEGER NOT NULL, target_id INTEGER NOT NULL,
        old_action_id TEXT NOT NULL, old_fence_sha256 TEXT NOT NULL,
        old_action_sha256 TEXT NOT NULL, new_action_id TEXT NOT NULL UNIQUE,
        new_request_hash TEXT NOT NULL, actor TEXT NOT NULL,
        snapshot_sha256 TEXT NOT NULL, module_sha256 TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL,
        review_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('available','consumed')),
        consumed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS deletion_resource_recovery_audit (
        grant_id TEXT PRIMARY KEY, previous_fence_json TEXT NOT NULL,
        previous_action_json TEXT NOT NULL, review_json TEXT NOT NULL,
        new_action_id TEXT NOT NULL, transferred_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS deletion_recovery_audit_no_update BEFORE UPDATE ON deletion_resource_recovery_audit BEGIN SELECT RAISE(ABORT,'immutable deletion recovery audit'); END;
      CREATE TRIGGER IF NOT EXISTS deletion_recovery_audit_no_delete BEFORE DELETE ON deletion_resource_recovery_audit BEGIN SELECT RAISE(ABORT,'immutable deletion recovery audit'); END;
    `);
  }

  enqueue(event) {
    const result = this.db
      .prepare(`
        INSERT OR IGNORE INTO events (
          event_id, event_type, occurred_at, object_type, object_id,
          related_json, changed_fields_json, payload_json, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.eventId,
        event.eventType,
        event.occurredAt,
        event.objectType,
        event.objectId,
        JSON.stringify(event.related ?? {}),
        JSON.stringify(event.changedFields ?? []),
        JSON.stringify(event.payload),
        new Date().toISOString(),
      );
    return result.changes === 1;
  }

  nextPending() {
    return this.db
      .prepare(`
        SELECT * FROM events
        WHERE status IN ('pending', 'retry')
          AND attempts < 8
        ORDER BY received_at
        LIMIT 1
      `)
      .get();
  }

  claim(eventId) {
    const result = this.db
      .prepare(`
        UPDATE events
        SET status = 'processing', attempts = attempts + 1, last_error = NULL
        WHERE event_id = ? AND status IN ('pending', 'retry')
      `)
      .run(eventId);
    return result.changes === 1;
  }

  complete(eventId, { resource, objectId, snapshotPath, workflow }) {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`
          INSERT INTO snapshots(event_id, resource_type, object_id, snapshot_path, fetched_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(event_id) DO UPDATE SET
            resource_type = excluded.resource_type,
            object_id = excluded.object_id,
            snapshot_path = excluded.snapshot_path,
            fetched_at = excluded.fetched_at
        `)
        .run(eventId, resource, objectId, snapshotPath, now);
      this.db
        .prepare(`
          INSERT OR IGNORE INTO review_tasks(event_id, workflow, created_at)
          VALUES (?, ?, ?)
        `)
        .run(eventId, workflow, now);
      this.db
        .prepare(`
          UPDATE events SET status = 'processed', processed_at = ?, last_error = NULL
          WHERE event_id = ?
        `)
        .run(now, eventId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  fail(eventId, error) {
    this.db
      .prepare(`
        UPDATE events
        SET status = CASE WHEN attempts >= 8 THEN 'failed' ELSE 'retry' END,
            last_error = ?
        WHERE event_id = ?
      `)
      .run(String(error?.message ?? error).slice(0, 2000), eventId);
  }

  nextReviewTask() {
    return this.db
      .prepare(`
        SELECT t.*, s.snapshot_path, e.event_type, e.object_type, e.object_id, e.occurred_at
        FROM review_tasks t
        JOIN events e ON e.event_id = t.event_id
        JOIN snapshots s ON s.event_id = t.event_id
        WHERE t.status = 'ready'
        ORDER BY t.created_at
        LIMIT 1
      `)
      .get();
  }

  claimReviewTask(taskId) {
    return (
      this.db
        .prepare(`UPDATE review_tasks SET status = 'processing', last_error = NULL WHERE task_id = ? AND status = 'ready'`)
        .run(taskId).changes === 1
    );
  }

  completeReviewTask(taskId, outputPath) {
    this.db
      .prepare(`
        UPDATE review_tasks
        SET status = 'completed', output_path = ?, completed_at = ?, last_error = NULL
        WHERE task_id = ?
      `)
      .run(outputPath, new Date().toISOString(), taskId);
  }

  failReviewTask(taskId, error) {
    this.db
      .prepare(`
        UPDATE review_tasks
        SET status = 'failed', last_error = ?
        WHERE task_id = ?
      `)
      .run(String(error?.message ?? error).slice(0, 2000), taskId);
  }

  failedReviewTasks() {
    return this.db
      .prepare(`
        SELECT task_id, event_id, workflow, created_at, last_error
        FROM review_tasks
        WHERE status = 'failed'
        ORDER BY created_at
      `)
      .all();
  }

  requeueFailedReviewTasks(limit = Number.POSITIVE_INFINITY) {
    const rows = Number.isFinite(limit)
      ? this.db
          .prepare(`
            SELECT task_id FROM review_tasks
            WHERE status = 'failed'
            ORDER BY created_at
            LIMIT ?
          `)
          .all(Math.max(0, Math.floor(limit)))
      : this.db
          .prepare(`
            SELECT task_id FROM review_tasks
            WHERE status = 'failed'
            ORDER BY created_at
          `)
          .all();
    if (rows.length === 0) return 0;
    const update = this.db.prepare(`
      UPDATE review_tasks
      SET status = 'ready', completed_at = NULL, last_error = NULL
      WHERE task_id = ? AND status = 'failed'
    `);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let changes = 0;
      for (const row of rows) changes += update.run(row.task_id).changes;
      this.db.exec("COMMIT");
      return changes;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  stats() {
    const eventRows = this.db.prepare(`SELECT status, COUNT(*) AS count FROM events GROUP BY status`).all();
    const taskRows = this.db.prepare(`SELECT status, COUNT(*) AS count FROM review_tasks GROUP BY status`).all();
    const actionRows = this.db.prepare(`SELECT status, COUNT(*) AS count FROM approved_actions GROUP BY status`).all();
    return {
      events: Object.fromEntries(eventRows.map((row) => [row.status, Number(row.count)])),
      tasks: Object.fromEntries(taskRows.map((row) => [row.status, Number(row.count)])),
      actions: Object.fromEntries(actionRows.map((row) => [row.status, Number(row.count)])),
    };
  }

  getCursor(resource) {
    return this.db.prepare(`SELECT cursor FROM sync_state WHERE resource_type = ?`).get(resource)?.cursor ?? null;
  }

  setCursor(resource, cursor) {
    this.db
      .prepare(`
        INSERT INTO sync_state(resource_type, cursor, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(resource_type) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at
      `)
      .run(resource, cursor, new Date().toISOString());
  }

  prepareApprovedAction(action) {
    const requestJson = stableJson(action.request);
    const requestHash = createHash("sha256").update(requestJson).digest("hex");
    this.db.prepare(`
      INSERT OR IGNORE INTO approved_actions(
        action_id, action_type, request_hash, request_json, requested_by,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      action.id,
      action.type,
      requestHash,
      requestJson,
      action.requestedBy,
      new Date().toISOString(),
    );
    const stored = this.approvedAction(action.id);
    if (
      stored.action_type !== action.type ||
      stored.request_hash !== requestHash ||
      stored.requested_by !== action.requestedBy
    ) {
      throw new Error(
        `SIBEMA action ${action.id} already exists with different exact content`,
      );
    }
    return stored;
  }

  approvedAction(actionId) {
    return this.db.prepare(
      `SELECT * FROM approved_actions WHERE action_id = ?`,
    ).get(actionId);
  }

  approveAction(actionId, approvedBy) {
    const result = this.db.prepare(`
      UPDATE approved_actions
      SET status = 'approved', approved_by = ?, approved_at = ?,
          last_error = NULL
      WHERE action_id = ? AND status IN ('prepared', 'approved', 'failed')
    `).run(approvedBy, new Date().toISOString(), actionId);
    if (result.changes !== 1) {
      const existing = this.approvedAction(actionId);
      if (existing?.status === "completed") return existing;
      throw new Error(`SIBEMA action ${actionId} is not ready for approval`);
    }
    return this.approvedAction(actionId);
  }

  claimApprovedAction(actionId) {
    return this.db.prepare(`
      UPDATE approved_actions
      SET status = 'executing', last_error = NULL
      WHERE action_id = ? AND status = 'approved'
    `).run(actionId).changes === 1;
  }

  // /proc identity must be complete; a PID alone is not a process identity.
  pdfProcessIdentity(pid) {
    if (process.platform !== 'linux') throw Error('Linux process identity required');
    const boot=readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
    const ns=readlinkSync('/proc/self/ns/pid');if(!/^pid:\[\d+\]$/.test(ns))throw Error('Invalid PID namespace');
    const self=readFileSync('/proc/self/stat','utf8');if(Number(self.slice(0,self.indexOf(' ')))!==process.pid)throw Error('Mismatched proc PID namespace');
    if (!/^[0-9a-f-]{36}$/i.test(boot)) throw Error('Invalid boot identity');
    let stat;
    try { stat=readFileSync(`/proc/${pid}/stat`,'utf8'); }
    catch(error) {
      if(error.code!=='ENOENT')throw error;
      // ENOENT alone can be caused by hidepid. A successful signal-0 probe
      // proves it is alive; EPERM is unknown/alive; only ESRCH confirms absence.
      try{process.kill(pid,0);throw Error('Process exists but proc identity is hidden');}catch(probe){if(probe.code!=='ESRCH')throw probe;}
      return {boot,pid,ns,gone:true};
    }
    const targetNs=readlinkSync(`/proc/${pid}/ns/pid`);if(targetNs!==ns)throw Error('Different PID namespace');
    const close=stat.lastIndexOf(')'),fields=stat.slice(close+2).split(' '),start=fields[19];
    if(close<0||!/^\d+$/.test(start??''))throw Error('Invalid process identity');
    return {boot,pid,start,ns,gone:false};
  }

  pdfCompletionVerified(orderId, actionId, phase) {
    const row=this.approvedAction(actionId);let req,proof,result;try{req=JSON.parse(row?.request_json??'null');proof=JSON.parse(row?.readback_json??'null');result=JSON.parse(row?.result_json??'null');}catch{}
    if(row?.status!=='completed'||req?.orderId!==orderId||proof?.order_id!==orderId||proof?.independent_readback!==true)return false;
    if(row.action_type==='attach_order_pdf')return Number.isSafeInteger(proof.file_id)&&proof.file_id>0&&proof.file_id===result?.file_id&&proof.filename===req?.body?.filename&&typeof req?.body?.content_base64==='string'&&/^[a-f0-9]{64}$/.test(proof.sha256??'')&&proof.sha256===createHash('sha256').update(Buffer.from(req.body.content_base64,'base64')).digest('hex')&&proof.order_preserved===true&&(phase==='checking'?result?.already_present===true:phase==='dispatch'&&result?.created===true&&proof.other_files_preserved===true);
    if(row.action_type==='remove_order_pdf')return proof.file_id===req?.fileId&&result?.file_id===req.fileId&&(phase==='checking'?proof.already_absent===true&&result?.already_absent===true:phase==='dispatch'&&proof.removed===true&&result?.removed===true&&/^[a-f0-9]{64}$/.test(req?.body?.expectedSha256??'')&&proof.original_sha256===req.body.expectedSha256&&proof.order_preserved===true&&proof.other_files_preserved===true);
    return false;
  }
  claimOrderPdfOrder(orderId, actionId, {claimApproved=false,approvedBy}={}) {
    if(!Number.isSafeInteger(orderId)||orderId<1||typeof actionId!=='string'||!actionId)throw Error('Invalid order PDF fence');
    const owner=this.pdfProcessIdentity(process.pid);if(owner.gone)throw Error('Current process missing');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Older filename fences cannot be safely interpreted if their action is missing.
      const legacy=this.db.prepare('SELECT f.resource_sha256,f.action_id,a.request_json FROM order_pdf_resource_fences f LEFT JOIN approved_actions a ON a.action_id=f.action_id').all();
      for(const row of legacy){let request;try{request=JSON.parse(row.request_json??'null');}catch{}if(!Number.isSafeInteger(request?.orderId))throw Error('Unreadable legacy PDF fence requires reconciliation');if(request.orderId!==orderId)continue;
        if(typeof request?.body?.filename!=='string'||row.resource_sha256!==createHash('sha256').update(JSON.stringify(['trinalum-production',orderId,request.body.filename])).digest('hex'))throw Error('Invalid legacy PDF fence identity');
        if(!this.pdfCompletionVerified(orderId,row.action_id,'dispatch')&&!this.pdfCompletionVerified(orderId,row.action_id,'checking'))throw Error('Legacy PDF fence requires reconciliation');
        if(this.db.prepare('DELETE FROM order_pdf_resource_fences WHERE resource_sha256=? AND action_id=?').run(row.resource_sha256,row.action_id).changes!==1)throw Error('Legacy PDF fence changed');
      }
      const old=this.db.prepare('SELECT * FROM order_pdf_order_fences WHERE order_id=?').get(orderId);
      if(old){
        if(!/^[0-9a-f-]{36}$/i.test(old.boot_id??'')||!Number.isSafeInteger(old.pid)||old.pid<1||!/^\d+$/.test(old.start_ticks??'')||!/^pid:\[\d+\]$/.test(old.pid_namespace??''))throw Error('Invalid saved process identity');
        if(old.phase==='dispatch'&&!this.pdfCompletionVerified(orderId,old.action_id,old.phase))throw Error('Order PDF dispatch is uncertain; no replay');
        if(old.phase==='checking'){
          if(owner.boot===old.boot_id){
            if(old.pid_namespace!==owner.ns)throw Error('PID namespace changed; checking recovery requires reconciliation');
            const observed=this.pdfProcessIdentity(old.pid);
            if(!observed.gone && observed.start===old.start_ticks)throw Error('Order PDF resource is already fenced');
          }
        }
        // Reclaim only an abandoned pre-dispatch check or durably verified completion.
        const removed=this.db.prepare("DELETE FROM order_pdf_order_fences WHERE order_id=? AND action_id=? AND phase=? AND boot_id=? AND pid=? AND start_ticks=? AND pid_namespace=?").run(orderId,old.action_id,old.phase,old.boot_id,old.pid,old.start_ticks,old.pid_namespace);
        if(removed.changes!==1)throw Error('Order PDF recovery fence changed');
        this.db.prepare('INSERT INTO order_pdf_fence_recoveries(order_id,old_action_id,new_action_id,old_phase,old_boot_id,old_pid,old_start_ticks,old_pid_namespace,reason,recovered_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(orderId,old.action_id,actionId,old.phase,old.boot_id,old.pid,old.start_ticks,old.pid_namespace,old.phase==='checking'?'dead_before_dispatch':'verified_completed',new Date().toISOString());
        if(old.phase==='checking')this.db.prepare("UPDATE approved_actions SET status='failed',last_error='Interrupted before provider dispatch; checking fence recovered' WHERE action_id=? AND status='executing'").run(old.action_id);
      }
      if(claimApproved){
        const action=this.approvedAction(actionId);let request;try{request=JSON.parse(action?.request_json??'null');}catch{}
        if(!approvedBy||action?.requested_by!==approvedBy||!['attach_order_pdf','remove_order_pdf'].includes(action?.action_type)||request?.orderId!==orderId)throw Error('Approved order PDF action identity mismatch');
        this.approveAction(actionId,approvedBy);
        if(!this.claimApprovedAction(actionId))throw Error('Approved order PDF action could not be claimed');
      }
      this.db.prepare("INSERT INTO order_pdf_order_fences(order_id,action_id,phase,boot_id,pid,start_ticks,pid_namespace,claimed_at) VALUES(?,?,'checking',?,?,?,?,?)").run(orderId,actionId,owner.boot,owner.pid,owner.start,owner.ns,new Date().toISOString());
      this.db.exec('COMMIT');return {orderId,actionId,boot:owner.boot,pid:owner.pid,start:owner.start,ns:owner.ns};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  dispatchOrderPdfOrder(claim) {
    const result=this.db.prepare("UPDATE order_pdf_order_fences SET phase='dispatch' WHERE order_id=? AND action_id=? AND phase='checking' AND boot_id=? AND pid=? AND start_ticks=? AND pid_namespace=?").run(claim.orderId,claim.actionId,claim.boot,claim.pid,claim.start,claim.ns);
    if(result.changes!==1)throw Error('Order PDF dispatch fence changed');
  }
  releaseOrderPdfChecking(claim) {
    const result=this.db.prepare("DELETE FROM order_pdf_order_fences WHERE order_id=? AND action_id=? AND phase='checking' AND boot_id=? AND pid=? AND start_ticks=? AND pid_namespace=?").run(claim.orderId,claim.actionId,claim.boot,claim.pid,claim.start,claim.ns);
    return result.changes===1;
  }
  releaseCompletedOrderPdf(claim) {
    this.db.exec('BEGIN IMMEDIATE');try{
      const fence=this.db.prepare('SELECT phase FROM order_pdf_order_fences WHERE order_id=? AND action_id=? AND boot_id=? AND pid=? AND start_ticks=? AND pid_namespace=?').get(claim.orderId,claim.actionId,claim.boot,claim.pid,claim.start,claim.ns);
      if(!fence||!this.pdfCompletionVerified(claim.orderId,claim.actionId,fence.phase))throw Error('Missing verified order PDF completion');
      const result=this.db.prepare('DELETE FROM order_pdf_order_fences WHERE order_id=? AND action_id=? AND boot_id=? AND pid=? AND start_ticks=? AND pid_namespace=?').run(claim.orderId,claim.actionId,claim.boot,claim.pid,claim.start,claim.ns);if(result.changes!==1)throw Error('Order PDF completion fence changed');this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }

  claimOfferMutation(offerId, actionId, expectedAfter) {
    if(!Number.isSafeInteger(offerId)||offerId<1||typeof actionId!=='string'||actionId.length<8||!expectedAfter?.snapshot?.header||!Number.isSafeInteger(expectedAfter.line_id)||typeof expectedAfter.changed!=='boolean')throw Error('Invalid offer mutation identity/state');
    this.db.exec('CREATE TABLE IF NOT EXISTS offer_mutation_fences (offer_id INTEGER PRIMARY KEY, action_id TEXT NOT NULL, expected_after_json TEXT NOT NULL, claimed_at TEXT NOT NULL)');
    if(this.db.prepare('INSERT OR IGNORE INTO offer_mutation_fences(offer_id,action_id,expected_after_json,claimed_at) VALUES(?,?,?,?)').run(offerId,actionId,JSON.stringify(expectedAfter),new Date().toISOString()).changes!==1)throw Error('Offer line mutation already in progress or uncertain; read the existing line to reconcile without repeating writes');
  }
  releaseOfferMutation(offerId, actionId) {
    // A concurrent authoritative read may already have reconciled this exact action.
    this.db.prepare('DELETE FROM offer_mutation_fences WHERE offer_id=? AND action_id=?').run(offerId,actionId);
  }
  reconcileOfferMutation(offerId, observedSnapshot) {
    if(!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='offer_mutation_fences'").get())return null;
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const saved=this.db.prepare('SELECT * FROM offer_mutation_fences WHERE offer_id=?').get(offerId);
      if(!saved){this.db.exec('COMMIT');return null;}
      const expected=JSON.parse(saved.expected_after_json),action=this.approvedAction(saved.action_id);
      if(JSON.stringify(expected.snapshot)!==JSON.stringify(observedSnapshot)){this.db.exec('COMMIT');return {status:'unresolved',writeRepeated:false};}
      let request;try{request=JSON.parse(action?.request_json??'null');}catch{}
      const path=`/offers/${offerId}/lines/${expected.line_id}`;
      const matches=action?.action_type==='api_request'&&request?.method==='PATCH'&&request.path===path||action?.action_type==='update_offer_line'&&request?.offerId===offerId&&request.lineId===expected.line_id;
      if(!matches||!['executing','uncertain'].includes(action.status)||action.approved_by!==action.requested_by||createHash('sha256').update(action.request_json).digest('hex')!==action.request_hash){this.db.exec('COMMIT');return {status:'unresolved',writeRepeated:false};}
      const row=observedSnapshot.lines.find(x=>x.line_id===expected.line_id);if(!row)throw Error('Reconciled line identity unavailable');
      const result={offer_id:offerId,line_id:expected.line_id,changed:expected.changed,reconciled_by_read:true};
      const readback={offer_id:offerId,line_id:expected.line_id,line:{...row,offer_id:offerId,reference:row.description},expectedSnapshotSha256:createHash('sha256').update(JSON.stringify(observedSnapshot)).digest('hex'),independent_readback:true,line_identity_preserved:true,header_preserved:true,siblings_preserved:true,relationships_preserved:true,reconciled_by_read:true};
      this.db.prepare("UPDATE approved_actions SET status='completed',executed_at=?,result_json=?,readback_json=?,last_error=NULL WHERE action_id=? AND status IN ('executing','uncertain')").run(new Date().toISOString(),JSON.stringify(result),JSON.stringify(action.action_type==='api_request'?{data:readback,verification:{independent_readback:true,specific_adapter:true}}:readback),saved.action_id);
      this.db.prepare('DELETE FROM offer_mutation_fences WHERE offer_id=? AND action_id=? AND expected_after_json=?').run(offerId,saved.action_id,saved.expected_after_json);
      this.db.exec('COMMIT');return {status:'completed',independent_readback:true,writeRepeated:false};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }

  claimOrderPdfResource(orderId, filename, actionId) {
    if (!Number.isSafeInteger(orderId) || orderId < 1 || typeof filename !== "string" || !filename || typeof actionId !== "string" || !actionId) throw Error("Invalid order PDF resource");
    const key = createHash("sha256").update(JSON.stringify(["trinalum-production", orderId, filename])).digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let claimed = this.db.prepare("INSERT OR IGNORE INTO order_pdf_resource_fences(resource_sha256,action_id,claimed_at) VALUES(?,?,?)").run(key, actionId, new Date().toISOString()).changes === 1;
      if (!claimed) {
        const prior = this.db.prepare("SELECT f.action_id, a.status, a.action_type, a.request_json, a.readback_json FROM order_pdf_resource_fences f LEFT JOIN approved_actions a ON a.action_id=f.action_id WHERE f.resource_sha256=?").get(key);
        let request, readback;
        try { request=JSON.parse(prior?.request_json ?? "null"); readback=JSON.parse(prior?.readback_json ?? "null"); } catch { /* fail closed */ }
        if (prior?.status === "completed" && prior.action_type === "attach_order_pdf" && request?.orderId === orderId && request?.body?.filename === filename && readback?.order_id === orderId && readback?.filename === filename && readback?.independent_readback === true && /^[a-f0-9]{64}$/.test(readback?.sha256 ?? "")) {
          if (this.db.prepare("DELETE FROM order_pdf_resource_fences WHERE resource_sha256=? AND action_id=?").run(key, prior.action_id).changes !== 1) throw Error("Order PDF resource fence changed");
          claimed = this.db.prepare("INSERT OR IGNORE INTO order_pdf_resource_fences(resource_sha256,action_id,claimed_at) VALUES(?,?,?)").run(key, actionId, new Date().toISOString()).changes === 1;
        }
      }
      if (!claimed) throw Error("Order PDF resource is already fenced; no additional dispatch");
      this.db.exec("COMMIT");
      return key;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  releaseOrderPdfResource(key, actionId) {
    if (this.db.prepare("DELETE FROM order_pdf_resource_fences WHERE resource_sha256=? AND action_id=?").run(key, actionId).changes !== 1) throw Error("Order PDF resource fence changed");
  }

  completeApprovedAction(actionId, result, readback) {
    this.db.prepare(`
      UPDATE approved_actions
      SET status = 'completed', executed_at = ?, result_json = ?,
          readback_json = ?, last_error = NULL
      WHERE action_id = ? AND status = 'executing'
    `).run(
      new Date().toISOString(),
      JSON.stringify(result ?? null),
      JSON.stringify(readback ?? null),
      actionId,
    );
  }

  failApprovedAction(actionId, error) {
    this.db.prepare(`
      UPDATE approved_actions
      SET status = ?, last_error = ?
      WHERE action_id = ? AND status = 'executing'
    `).run(error?.outcomeUncertain === true ? "uncertain" : error?.definitiveRejection === true ? "rejected" : "failed", String(error?.message ?? error).slice(0, 2000), actionId);
  }

  claimDeletionResource({integration,kind,customerId,targetId,actionId,actor,snapshotSha256,requestHash,moduleSha256}) {
    this.validateDeletionResource({integration,kind,customerId,targetId});
    if(typeof actionId!=='string'||actionId.length<8||actionId.length>200||!['Trini','Miguel','Nerea'].includes(actor)||!/^[a-f0-9]{64}$/.test(snapshotSha256??''))throw Error('Invalid deletion claim');
    // One atomic SQLite insert across processes. No state, proof, actor or new
    // action ID can replace an existing resource claim; there is no release API.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let claimed=this.db.prepare(`INSERT OR IGNORE INTO deletion_resource_fences(integration,kind,customer_id,target_id,action_id,actor,snapshot_sha256,status,claimed_at) VALUES(?,?,?,?,?,?,?,'dispatch',?)`).run(integration,kind,customerId,targetId,actionId,actor,snapshotSha256,new Date().toISOString()).changes===1;
      if(!claimed){
        const grant=this.db.prepare("SELECT * FROM deletion_recovery_grants WHERE integration=? AND kind=? AND customer_id=? AND target_id=? AND new_action_id=? AND state='available'").get(integration,kind,customerId,targetId,actionId);
        const previous=this.deletionResource({integration,kind,customerId,targetId}),old=previous&&this.approvedAction(previous.action_id),next=this.approvedAction(actionId),now=Date.now();
        if(grant&&previous&&old&&next&&previous.status==='uncertain'&&old.status==='uncertain'&&previous.action_id===grant.old_action_id&&previous.actor===actor&&actor===grant.actor&&grant.expires_at_ms>now&&grant.expires_at_ms-grant.created_at_ms<=120000&&grant.created_at_ms<=now&&grant.snapshot_sha256===snapshotSha256&&previous.snapshot_sha256===snapshotSha256&&grant.module_sha256===moduleSha256&&grant.new_request_hash===requestHash&&rowHash(previous)===grant.old_fence_sha256&&rowHash(old)===grant.old_action_sha256&&this.recoveryActionMatches(next,{kind,customerId,targetId,actor,snapshotSha256,requestHash,status:'executing'})){
          const at=new Date().toISOString();
          this.db.prepare('INSERT INTO deletion_resource_recovery_audit(grant_id,previous_fence_json,previous_action_json,review_json,new_action_id,transferred_at) VALUES(?,?,?,?,?,?)').run(grant.grant_id,stableJson(previous),stableJson(old),grant.review_json,actionId,at);
          if(this.db.prepare("UPDATE deletion_recovery_grants SET state='consumed',consumed_at=? WHERE grant_id=? AND state='available'").run(at,grant.grant_id).changes!==1)throw Error('Recovery authorization already consumed');
          if(this.db.prepare("UPDATE deletion_resource_fences SET action_id=?,actor=?,snapshot_sha256=?,status='dispatch',claimed_at=?,finished_at=NULL WHERE integration=? AND kind=? AND customer_id=? AND target_id=? AND action_id=? AND status='uncertain'").run(actionId,actor,snapshotSha256,at,integration,kind,customerId,targetId,grant.old_action_id).changes!==1)throw Error('Recovery fence compare failed');
          claimed=true;
        }
      }
      this.db.exec('COMMIT');return claimed;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }

  recoveryActionMatches(action,{kind,customerId,targetId,actor,snapshotSha256,requestHash,status}) {
    if(action.status!==status||action.action_type!==(kind==='offer'?'delete_offer':'delete_customer_tariff')||action.requested_by!==actor||status==='executing'&&action.approved_by!==actor||action.request_hash!==requestHash||createHash('sha256').update(action.request_json).digest('hex')!==requestHash)return false;
    try{const r=JSON.parse(action.request_json);return r.customerId===customerId&&r[kind==='offer'?'offerId':'tariffId']===targetId&&r.body.expectedSnapshotSha256===snapshotSha256;}catch{return false;}
  }

  // Host-operator-only method: no chat/API route exposes grant creation. A root
  // reviewed helper supplies two fresh complete reads and exact installed pins.
  authorizeDeletionRecovery(review) {
    const {integration,kind,customerId,targetId,oldActionId,oldFenceSha256,oldActionSha256,newActionId,newRequestHash,actor,snapshotSha256,moduleSha256,createdAtMs,expiresAtMs,readbacks}=review;
    this.validateDeletionResource(review);const now=Date.now();
    if(typeof review.grantId!=='string'||review.grantId.length<16||!['Trini','Miguel','Nerea'].includes(actor)||![oldFenceSha256,oldActionSha256,newRequestHash,snapshotSha256,moduleSha256].every(x=>/^[a-f0-9]{64}$/.test(x??''))||!Number.isSafeInteger(createdAtMs)||!Number.isSafeInteger(expiresAtMs)||createdAtMs>now||expiresAtMs<=now||expiresAtMs-createdAtMs>120000||!Array.isArray(readbacks)||readbacks.length!==2||readbacks.some(x=>x.snapshotSha256!==snapshotSha256||x.moduleSha256!==moduleSha256||!Number.isSafeInteger(x.atMs)||x.atMs>now||now-x.atMs>30000)||readbacks[0].atMs>readbacks[1].atMs||typeof review.reason!=='string'||!review.reason.trim())throw Error('Invalid reviewed recovery evidence');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const previous=this.deletionResource(review),old=this.approvedAction(oldActionId),next=this.approvedAction(newActionId);
      if(!previous||!old||!next||previous.status!=='uncertain'||old.status!=='uncertain'||old.requested_by!==actor||old.approved_by!==actor||previous.action_id!==oldActionId||previous.actor!==actor||previous.snapshot_sha256!==snapshotSha256||rowHash(previous)!==oldFenceSha256||rowHash(old)!==oldActionSha256||!this.recoveryActionMatches(next,{kind,customerId,targetId,actor,snapshotSha256,requestHash:newRequestHash,status:'prepared'})||newActionId===oldActionId)throw Error('Reviewed recovery compare failed');
      this.db.prepare("INSERT INTO deletion_recovery_grants(grant_id,integration,kind,customer_id,target_id,old_action_id,old_fence_sha256,old_action_sha256,new_action_id,new_request_hash,actor,snapshot_sha256,module_sha256,created_at_ms,expires_at_ms,review_json,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'available')").run(review.grantId,integration,kind,customerId,targetId,oldActionId,oldFenceSha256,oldActionSha256,newActionId,newRequestHash,actor,snapshotSha256,moduleSha256,createdAtMs,expiresAtMs,stableJson(review));
      this.db.exec('COMMIT');return {grantId:review.grantId,state:'available',expiresAtMs,oldActionUnchanged:true,oldFenceUnchanged:true};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }

  validateDeletionResource({integration,kind,customerId,targetId}) {
    if(!/^[a-f0-9]{64}$/.test(integration??'')||!['tariff','offer'].includes(kind)||![customerId,targetId].every(v=>Number.isSafeInteger(v)&&v>0))throw Error('Invalid deletion resource');
  }

  deletionResource(resource) {
    this.validateDeletionResource(resource);return this.db.prepare('SELECT * FROM deletion_resource_fences WHERE integration=? AND kind=? AND customer_id=? AND target_id=?').get(resource.integration,resource.kind,resource.customerId,resource.targetId);
  }

  finishDeletionResource(resource,actionId,status) {
    this.validateDeletionResource(resource);if(!['completed','rejected','uncertain'].includes(status))throw Error('Invalid deletion disposition');
    const r=this.db.prepare(`UPDATE deletion_resource_fences SET status=?,finished_at=? WHERE integration=? AND kind=? AND customer_id=? AND target_id=? AND action_id=? AND status='dispatch'`).run(status,new Date().toISOString(),resource.integration,resource.kind,resource.customerId,resource.targetId,actionId);
    if(r.changes!==1)throw Error('Deletion fence disposition could not be persisted');
  }

  close() {
    this.db.close();
  }
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

function rowHash(value){return createHash('sha256').update(stableJson(value)).digest('hex');}
