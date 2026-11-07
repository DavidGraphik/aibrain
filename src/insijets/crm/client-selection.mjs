import { createHash } from 'node:crypto';

// Client-side only: no provider client, token, transport, logging or activation.
// A release is an exact value attestation from a trusted client custodian,
// not consent to contact the person and never an assertion made by the model.
export const MINIMUM_FIELD_MAP = Object.freeze({
  email: 'email', greeting: 'greeting', locale: 'locale', owner_id: 'owner_id',
  account_id: 'account_id', email_verification_ref: 'email_verification_ref',
  previousEnquiryDate: 'previousEnquiryDate', previousQuoteDate: 'previousQuoteDate',
  previousContactMonth: 'previousContactMonth', previousService: 'previousService',
  confirmedProfessionalContext: 'confirmedProfessionalContext',
});
const states = new Set(['open', 'closed_lost', 'closed_won']);
const flags = ['optOut', 'currentCustomer', 'activeConversation'];
const ref = value => typeof value === 'string' && /^[a-zA-Z0-9_:/.-]{1,120}$/.test(value);
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const email = value => typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const normalizedEmail = value => email(value) ? value.trim().toLowerCase() : null;
const own = (value, key) => Object.hasOwn(value, key);
const keysOnly = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const POLICY_KEYS = ['tenantId', 'cohortId', 'revision', 'snapshotRevision', 'custodianRef', 'revoked', 'expiresAt', 'exactRecordIds', 'maxSnapshotAgeMs', 'maxSuppressionAgeMs', 'stageMap', 'releases', 'suppression', 'existingCustomerReviews'];
const RELEASE_KEYS = ['recordId', 'field', 'classification', 'valueDigest', 'evidenceRef', 'evidenceAt'];
const SUPPRESSION_KEYS = ['recordId', 'evidenceRef', 'checkedAt', ...flags];
const REVIEW_KEYS = ['recordId', 'disposition', 'evidenceRef', 'reviewedAt'];
const PACKET_KEYS = ['version', 'tenantId', 'cohortId', 'policyRevision', 'snapshotRevision', 'custodianRef', 'policyDigest', 'selectedAt', 'expiresAt', 'selected', 'holds', 'excluded', 'digest'];
const HOLD_REASONS = new Set(['duplicate_record_identity', 'record_missing', 'suppression_missing_or_ambiguous', 'suppression_stale_or_unknown', 'record_exclusions_unknown', 'ambiguous_email_identity', 'email_invalid', 'deal_identity_unknown', 'stage_or_lead_state_unknown', 'mixed_won_history_customer_review', 'facts_invalid', 'reviewed_minimum_facts_missing']);
const EXCLUDED_REASONS = new Set([...flags, 'outside_historical_universe']);
const fail = () => { throw new Error('Client selection unavailable: scope, freshness or trusted policy invalid'); };
export const factValueDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function digest(value) { return factValueDigest(value); }
function policyDigest(policy) { const { suppression, ...scope } = policy; return digest(scope); }
function checkPolicy(policy, now) {
  if (!keysOnly(policy, POLICY_KEYS) || !ref(policy.tenantId) || !ref(policy.cohortId) || !ref(policy.revision) || !ref(policy.snapshotRevision) || !ref(policy.custodianRef)
    || policy.revoked !== false || !time(policy.expiresAt) || Date.parse(policy.expiresAt) <= now
    || !Array.isArray(policy.exactRecordIds) || !policy.exactRecordIds.length || policy.exactRecordIds.length > 1000
    || policy.exactRecordIds.some(id => !ref(id)) || new Set(policy.exactRecordIds).size !== policy.exactRecordIds.length
    || !Array.isArray(policy.releases) || policy.releases.length > 20000 || !Array.isArray(policy.suppression)
    || !Number.isInteger(policy.maxSnapshotAgeMs) || policy.maxSnapshotAgeMs < 1 || policy.maxSnapshotAgeMs > 86400000
    || !Number.isInteger(policy.maxSuppressionAgeMs) || policy.maxSuppressionAgeMs < 1 || policy.maxSuppressionAgeMs > 3600000
    || !policy.stageMap || typeof policy.stageMap !== 'object' || Array.isArray(policy.stageMap)
    || Object.entries(policy.stageMap).some(([key, value]) => !ref(key) || !states.has(value))) fail();
  if (policy.releases.some(r => !keysOnly(r, RELEASE_KEYS) || !ref(r.recordId) || !own(MINIMUM_FIELD_MAP, r.field) || r.classification !== 'non_confidential'
    || !ref(r.evidenceRef) || !time(r.evidenceAt) || Date.parse(r.evidenceAt) > now || !/^[a-f0-9]{64}$/.test(r.valueDigest))) fail();
  if (policy.suppression.some(r => !keysOnly(r, SUPPRESSION_KEYS) || !ref(r.recordId))) fail();
  if (policy.existingCustomerReviews !== undefined && (!Array.isArray(policy.existingCustomerReviews) || policy.existingCustomerReviews.some(r => !keysOnly(r, REVIEW_KEYS) || !ref(r.recordId) || r.disposition !== 'historical_outreach_allowed' || !ref(r.evidenceRef) || !time(r.reviewedAt) || Date.parse(r.reviewedAt) > now))) fail();
}
function suppressionReason(policy, recordId, now) {
  const checks = policy.suppression.filter(row => row.recordId === recordId);
  if (checks.length !== 1) return 'suppression_missing_or_ambiguous';
  const check = checks[0];
  if (!ref(check.evidenceRef) || !time(check.checkedAt) || Date.parse(check.checkedAt) > now || now - Date.parse(check.checkedAt) > policy.maxSuppressionAgeMs
    || flags.some(key => typeof check[key] !== 'boolean')) return 'suppression_stale_or_unknown';
  return flags.find(key => check[key]) || null;
}
function mixedReviewCurrent(policy, recordRef, now) {
  const reviews = (policy.existingCustomerReviews || []).filter(r => r.recordId === recordRef);
  return reviews.length === 1 && now - Date.parse(reviews[0].reviewedAt) <= policy.maxSnapshotAgeMs;
}
function isMixed(deals) { return deals.some(d => d.state === 'closed_won') && deals.some(d => ['open', 'closed_lost'].includes(d.state)); }
function releasedFacts(record, policy, now) {
  const result = [];
  for (const field of Object.keys(MINIMUM_FIELD_MAP)) {
    const releases = policy.releases.filter(r => r.recordId === record.id && r.field === field);
    const facts = (record.facts || []).filter(f => f.field === field);
    if (releases.length !== 1 || facts.length !== 1) continue;
    const release = releases[0], fact = facts[0];
    if (fact.classification !== 'non_confidential' || fact.evidenceRef !== release.evidenceRef || fact.evidenceAt !== release.evidenceAt
      || !time(fact.evidenceAt) || Date.parse(fact.evidenceAt) > now || typeof fact.value !== 'string'
      || !fact.value.trim() || fact.value.length > 320 || /[\u0000-\u001f\u007f]/.test(fact.value)
      || factValueDigest(fact.value) !== release.valueDigest) continue;
    if (field === 'email' && (fact.value !== normalizedEmail(fact.value) || fact.value !== normalizedEmail(record.email))) continue;
    if ((field.endsWith('_ref') || ['owner_id', 'account_id'].includes(field)) && !ref(fact.value)) continue;
    if (field === 'locale' && !['en', 'it', 'es', 'fr', 'de', 'ar'].includes(fact.value)) continue;
    if (field.endsWith('Date') && !/^\d{4}-\d{2}-\d{2}$/.test(fact.value)) continue;
    result.push({ field, value: field === 'email' ? normalizedEmail(fact.value) : fact.value, evidenceRef: fact.evidenceRef, evidenceAt: fact.evidenceAt });
  }
  return result;
}

export function selectClientCohort(snapshot, policy, { now = Date.now() } = {}) {
  checkPolicy(policy, now);
  if (!snapshot || snapshot.tenantId !== policy.tenantId || snapshot.revision !== policy.snapshotRevision
    || !time(snapshot.generatedAt) || Date.parse(snapshot.generatedAt) > now || now - Date.parse(snapshot.generatedAt) > policy.maxSnapshotAgeMs
    || !Array.isArray(snapshot.records) || snapshot.records.length > 100000) fail();
  const byId = new Map(), byEmail = new Map();
  for (const record of snapshot.records) {
    if (!record || !ref(record.id)) fail();
    const copies = byId.get(record.id) || []; copies.push(record); byId.set(record.id, copies);
    const address = normalizedEmail(record.email);
    if (address) { const ids = byEmail.get(address) || new Set(); ids.add(record.id); byEmail.set(address, ids); }
  }
  const selected = [], holds = [], excluded = [];
  for (const recordRef of policy.exactRecordIds) {
    const rows = byId.get(recordRef) || [];
    if (rows.length !== 1) { holds.push({ recordRef, reason: rows.length ? 'duplicate_record_identity' : 'record_missing' }); continue; }
    const record = rows[0], address = normalizedEmail(record.email), suppression = suppressionReason(policy, recordRef, now);
    if (flags.some(key => record[key] === true) || flags.includes(suppression)) {
      excluded.push({ recordRef, reason: flags.find(key => record[key] === true) || suppression }); continue;
    }
    if (suppression || flags.some(key => record[key] !== false)) { holds.push({ recordRef, reason: suppression || 'record_exclusions_unknown' }); continue; }
    if (!address || byEmail.get(address)?.size !== 1) { holds.push({ recordRef, reason: address ? 'ambiguous_email_identity' : 'email_invalid' }); continue; }
    if (!Array.isArray(record.deals) || record.deals.length > 1000 || record.deals.some(d => !d || !ref(d.id) || !ref(d.stageId))
      || new Set(record.deals.map(d => d.id)).size !== record.deals.length) { holds.push({ recordRef, reason: 'deal_identity_unknown' }); continue; }
    const deals = record.deals.map(d => ({ dealRef: d.id, stageRef: d.stageId, state: own(policy.stageMap, d.stageId) ? policy.stageMap[d.stageId] : 'unknown' }));
    if (deals.some(d => d.state === 'unknown') || !['unconverted', 'converted'].includes(record.leadState)) { holds.push({ recordRef, reason: 'stage_or_lead_state_unknown' }); continue; }
    if (record.leadState === 'unconverted' && deals.some(d => d.state === 'closed_won') && !isMixed(deals)) { holds.push({ recordRef, reason: 'stage_or_lead_state_unknown' }); continue; }
    if (record.leadState !== 'unconverted' && !deals.some(d => ['open', 'closed_lost'].includes(d.state))) { excluded.push({ recordRef, reason: 'outside_historical_universe' }); continue; }
    if (isMixed(deals)) {
      if (!mixedReviewCurrent(policy, recordRef, now)) {
        holds.push({ recordRef, reason: 'mixed_won_history_customer_review', deals }); continue;
      }
    }
    if (record.facts !== undefined && (!Array.isArray(record.facts) || record.facts.length > 100 || record.facts.some(f => !f || typeof f !== 'object'))) { holds.push({ recordRef, reason: 'facts_invalid' }); continue; }
    const facts = releasedFacts(record, policy, now), values = Object.fromEntries(facts.map(f => [f.field, f.value]));
    if (!values.email || !values.email_verification_ref || !values.locale) { holds.push({ recordRef, reason: 'reviewed_minimum_facts_missing' }); continue; }
    selected.push({ recordRef, email: values.email, leadState: record.leadState, deals, facts });
  }
  const result = { version: 1, tenantId: policy.tenantId, cohortId: policy.cohortId, policyRevision: policy.revision, snapshotRevision: snapshot.revision,
    custodianRef: policy.custodianRef, policyDigest: policyDigest(policy), selectedAt: new Date(now).toISOString(), expiresAt: policy.expiresAt, selected, holds, excluded };
  return { ...result, digest: digest(result) };
}

// expectedDigest MUST come from the client's protected durable selection record,
// never from the caller/model. A digest supplied alongside an untrusted package
// proves no authority. Fresh policy/suppression must be loaded on every use.
export function verifySelectedCohort(packet, policy, { now = Date.now(), expectedDigest } = {}) {
  checkPolicy(policy, now);
  if (!keysOnly(packet, PACKET_KEYS) || !/^[a-f0-9]{64}$/.test(expectedDigest || '')) fail();
  const { digest: claimed, ...body } = packet;
  if (claimed !== expectedDigest || digest(body) !== expectedDigest || packet.version !== 1 || packet.tenantId !== policy.tenantId
    || packet.cohortId !== policy.cohortId || packet.policyRevision !== policy.revision || packet.snapshotRevision !== policy.snapshotRevision
    || packet.custodianRef !== policy.custodianRef || packet.policyDigest !== policyDigest(policy) || packet.expiresAt !== policy.expiresAt || !time(packet.selectedAt)
    || Date.parse(packet.selectedAt) > now || now - Date.parse(packet.selectedAt) > policy.maxSnapshotAgeMs
    || !Array.isArray(packet.selected) || packet.selected.some(r => !policy.exactRecordIds.includes(r.recordRef) || suppressionReason(policy, r.recordRef, now) || (!Array.isArray(r.deals)) || (isMixed(r.deals) && !mixedReviewCurrent(policy, r.recordRef, now)))) fail();
  const validDeals = deals => Array.isArray(deals) && deals.length <= 1000 && deals.every(d => keysOnly(d, ['dealRef', 'stageRef', 'state']) && ref(d.dealRef) && ref(d.stageRef) && states.has(d.state) && own(policy.stageMap, d.stageRef) && policy.stageMap[d.stageRef] === d.state) && new Set(deals.map(d => d.dealRef)).size === deals.length;
  for (const row of packet.selected) {
    if (!keysOnly(row, ['recordRef', 'email', 'leadState', 'deals', 'facts']) || !ref(row.recordRef) || normalizedEmail(row.email) !== row.email
      || !['unconverted', 'converted'].includes(row.leadState) || !validDeals(row.deals) || (row.leadState === 'unconverted' && row.deals.some(d => d.state === 'closed_won') && !isMixed(row.deals)) || (row.leadState !== 'unconverted' && !row.deals.some(d => ['open', 'closed_lost'].includes(d.state)))
      || !Array.isArray(row.facts) || row.facts.length > Object.keys(MINIMUM_FIELD_MAP).length
      || row.facts.some(f => !keysOnly(f, ['field', 'value', 'evidenceRef', 'evidenceAt']) || !own(MINIMUM_FIELD_MAP, f.field))
      || new Set(row.facts.map(f => f.field)).size !== row.facts.length) fail();
    const reviewed = releasedFacts({ id: row.recordRef, email: row.email, facts: row.facts.map(f => ({ ...f, classification: 'non_confidential' })) }, policy, now);
    const values = Object.fromEntries(reviewed.map(f => [f.field, f.value]));
    if (reviewed.length !== row.facts.length || !values.email || values.email !== row.email || !values.locale || !values.email_verification_ref) fail();
  }
  if (!Array.isArray(packet.holds) || !Array.isArray(packet.excluded)) fail();
  for (const row of packet.holds) {
    const mixed = row?.reason === 'mixed_won_history_customer_review';
    if (!keysOnly(row, mixed ? ['recordRef', 'reason', 'deals'] : ['recordRef', 'reason']) || !ref(row.recordRef) || !HOLD_REASONS.has(row.reason)
      || (mixed && (!validDeals(row.deals) || !isMixed(row.deals)))) fail();
  }
  if (packet.excluded.some(row => !keysOnly(row, ['recordRef', 'reason']) || !ref(row.recordRef) || !EXCLUDED_REASONS.has(row.reason))) fail();
  const identities = [...packet.selected, ...packet.holds, ...packet.excluded].map(r => r.recordRef);
  if (identities.length !== policy.exactRecordIds.length || new Set(identities).size !== identities.length || identities.some(id => !policy.exactRecordIds.includes(id))
    || new Set(packet.selected.map(r => r.email)).size !== packet.selected.length) fail();
  return structuredClone(packet);
}
