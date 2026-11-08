import test from 'node:test';
import assert from 'node:assert/strict';
import { selectClientCohort, verifySelectedCohort, factValueDigest } from '../client-selection.mjs';
const now = Date.parse('2026-10-29T07:00:00.000Z');
const stamp = new Date(now - 1000).toISOString();
function fixture() {
  const records = ['new', 'lost', 'mixed', 'won'].map(id => ({ id, email: `${id}@example.test`, leadState: id === 'new' ? 'unconverted' : 'converted',
    optOut: false, currentCustomer: false, activeConversation: false,
    deals: id === 'new' ? [] : id === 'mixed' ? [{ id: 'mixed-won', stageId: 'won' }, { id: 'mixed-lost', stageId: 'lost' }, { id: 'mixed-open', stageId: 'open' }] : [{ id: `${id}-deal`, stageId: id }],
    facts: [{ field: 'email', value: `${id}@example.test` }, { field: 'locale', value: 'it' }, { field: 'greeting', value: 'Luca' }, { field: 'email_verification_ref', value: 'verified-ref' }].map(f => ({ ...f, classification: 'non_confidential', evidenceAt: stamp, evidenceRef: `evidence-${id}-${f.field}` })),
  }));
  const snapshot = { tenantId: 'insijets', revision: 'snapshot-1', generatedAt: stamp, records };
  const policy = { tenantId: 'insijets', cohortId: 'historical-1', revision: 'policy-1', snapshotRevision: 'snapshot-1', custodianRef: 'client-custodian', revoked: false,
    expiresAt: new Date(now + 60000).toISOString(), exactRecordIds: records.map(r => r.id), maxSnapshotAgeMs: 3600000, maxSuppressionAgeMs: 300000,
    stageMap: { won: 'closed_won', lost: 'closed_lost', open: 'open' },
    suppression: records.map(r => ({ recordId: r.id, evidenceRef: 'suppression-1', checkedAt: stamp, optOut: false, currentCustomer: false, activeConversation: false })),
    releases: records.flatMap(r => r.facts.map(f => ({ recordId: r.id, field: f.field, classification: f.classification, valueDigest: factValueDigest(f.value), evidenceAt: f.evidenceAt, evidenceRef: f.evidenceRef }))),
  };
  return { snapshot, policy };
}
const select = f => selectClientCohort(f.snapshot, f.policy, { now });
test('historical universe includes unconverted/open/lost and preserves every mixed deal without ICP gates', () => {
  const f = fixture(), before = JSON.stringify(f), result = select(f);
  assert.deepEqual(result.selected.map(r => r.recordRef), ['new', 'lost']);
  assert.equal(result.holds[0].reason, 'mixed_won_history_customer_review');
  assert.deepEqual(result.holds.find(r => r.recordRef === 'mixed').deals.map(d => d.state), ['closed_won', 'closed_lost', 'open']);
  assert.equal(result.excluded[0].reason, 'outside_historical_universe');
  assert.equal(JSON.stringify(f), before);
  assert.equal(verifySelectedCohort(result, f.policy, { now, expectedDigest: result.digest }).selected.length, 2);
});
test('exact client selection only; missing IDs, duplicate IDs/email and unknown stages hold without leaking rows', () => {
  const f = fixture();
  f.policy.exactRecordIds = ['new', 'mixed', 'missing'];
  f.snapshot.records.push({ ...structuredClone(f.snapshot.records[0]), id: 'alias' });
  f.snapshot.records[2].deals[0].stageId = 'unmapped';
  const result = select(f);
  assert.equal(result.selected.length, 0);
  assert.deepEqual(result.holds.map(r => r.reason), ['ambiguous_email_identity', 'stage_or_lead_state_unknown', 'record_missing']);
  assert.equal(JSON.stringify(result).includes('alias@example'), false);
  const g = fixture(); g.snapshot.records.push(structuredClone(g.snapshot.records[0]));
  assert.equal(select(g).holds[0].reason, 'duplicate_record_identity');
});
test('opt-out, customer and active conversation exclusions apply before historical selection', () => {
  const f = fixture();
  f.snapshot.records[0].optOut = true;
  f.policy.suppression[1].currentCustomer = true;
  f.snapshot.records[2].activeConversation = true;
  assert.deepEqual(select(f).excluded.slice(0, 3).map(r => r.reason), ['optOut', 'currentCustomer', 'activeConversation']);
});
test('only exact custodian-reviewed nonconfidential field values leave the client boundary', () => {
  const f = fixture(), r = f.snapshot.records[0];
  r.notes = 'SECRET-NOTE'; r.deals.push({ id: 'safe-deal', stageId: 'open', price: 'SECRET-PRICE', itinerary: 'SECRET-ITINERARY' });
  r.facts.push({ field: 'note_text', value: 'SECRET-NOTE', classification: 'non_confidential' }, { field: 'previousService', value: 'SECRET-CONTEXT', classification: 'confidential', evidenceAt: stamp, evidenceRef: 'secret-ref' });
  r.facts.find(f => f.field === 'greeting').value = 'SECRET-INJECTED';
  const result = select(f), text = JSON.stringify(result);
  assert.equal(result.selected[0].recordRef, 'new');
  assert.equal(text.includes('SECRET'), false);
  assert.equal(text.includes('note_text'), false);
  assert.deepEqual(result.selected[0].deals, [{ dealRef: 'safe-deal', stageRef: 'open', state: 'open' }]);
  assert.equal(result.selected[0].facts.some(f => f.field === 'greeting'), false);
});
test('missing reviewed email/verification/locale or ambiguous evidence holds rather than fabricating eligibility', () => {
  const f = fixture();
  f.policy.releases = f.policy.releases.filter(r => !(r.recordId === 'new' && r.field === 'email_verification_ref'));
  f.snapshot.records[1].facts.push(structuredClone(f.snapshot.records[1].facts[0]));
  f.snapshot.records[2].activeConversation = undefined;
  const result = select(f);
  assert.equal(result.selected.length, 0);
  assert.deepEqual(result.holds.map(r => r.reason), ['reviewed_minimum_facts_missing', 'reviewed_minimum_facts_missing', 'record_exclusions_unknown']);
});
test('foreign, revoked, expired or stale scope fails closed; stale suppression is a hold', () => {
  for (const change of [f => { f.snapshot.tenantId = 'foreign'; }, f => { f.policy.snapshotRevision = 'other'; }, f => { f.policy.revoked = true; },
    f => { f.policy.expiresAt = new Date(now).toISOString(); }, f => { f.snapshot.generatedAt = new Date(now - 3600001).toISOString(); }]) {
    const f = fixture(); change(f); assert.throws(() => select(f), /unavailable/);
  }
  const f = fixture(); f.policy.suppression[0].checkedAt = new Date(now - 300001).toISOString();
  assert.equal(select(f).holds[0].reason, 'suppression_stale_or_unknown');
});
test('persisted selection verification binds trusted digest, policy and fresh suppression without source snapshot', () => {
  const f = fixture(), result = select(f), expectedDigest = result.digest;
  const altered = structuredClone(result); altered.selected[0].email = 'attacker@example.test';
  assert.throws(() => verifySelectedCohort(altered, f.policy, { now, expectedDigest }));
  assert.throws(() => verifySelectedCohort(result, f.policy, { now }));
  f.policy.suppression[0].optOut = true;
  assert.throws(() => verifySelectedCohort(result, f.policy, { now, expectedDigest }));
  f.policy.suppression[0].optOut = false;
  f.policy.suppression[0].checkedAt = new Date(now).toISOString();
  assert.equal(verifySelectedCohort(result, f.policy, { now, expectedDigest }).digest, expectedDigest);
  f.policy.releases[0].valueDigest = factValueDigest('changed@example.test');
  assert.throws(() => verifySelectedCohort(result, f.policy, { now, expectedDigest }));
});

test('mixed won/lost requires a separate fresh client disposition while retaining all opportunity refs', () => {
  const f = fixture();
  f.policy.existingCustomerReviews = [{ recordId: 'mixed', disposition: 'historical_outreach_allowed', evidenceRef: 'client-customer-review', reviewedAt: stamp }];
  assert.equal(select(f).selected.find(r => r.recordRef === 'mixed').deals.length, 3);
  f.policy.existingCustomerReviews[0].reviewedAt = new Date(now - 3600001).toISOString();
  assert.equal(select(f).holds.find(r => r.recordRef === 'mixed').reason, 'mixed_won_history_customer_review');
  f.policy.existingCustomerReviews[0].reviewedAt = stamp;
  f.policy.suppression[2].currentCustomer = true;
  assert.equal(select(f).excluded.find(r => r.recordRef === 'mixed').reason, 'currentCustomer');
});

test('a mixed-history disposition must remain fresh when a stored selection is consumed', () => {
  const f = fixture();
  f.policy.existingCustomerReviews = [{ recordId: 'mixed', disposition: 'historical_outreach_allowed', evidenceRef: 'client-review', reviewedAt: new Date(now - 3599999).toISOString() }];
  const packet = select(f);
  assert.ok(packet.selected.find(r => r.recordRef === 'mixed'));
  assert.throws(() => verifySelectedCohort(packet, f.policy, { now: now + 2, expectedDigest: packet.digest }));
});

test('rehashed custodian packets still reject forbidden fields and unattested confidential values', () => {
  const f = fixture(), packet = select(f);
  const mutations = [
    p => { p.notes = 'PRIVATE-TOP-NOTE'; },
    p => { p.selected[0].notes = 'PRIVATE-ROW-NOTE'; },
    p => { p.selected[0].facts.push({ field: 'note_text', value: 'PRIVATE-BODY', evidenceRef: 'fake', evidenceAt: stamp }); },
    p => { p.selected[0].facts.push({ field: 'confirmedProfessionalContext', value: 'PRIVATE-PRICING', evidenceRef: 'fake', evidenceAt: stamp }); },
    p => { p.selected[0].facts[0].raw = 'PRIVATE-EXTRA'; },
    p => { p.holds[0].deals[0].price = 'PRIVATE-PRICE'; },
    p => { p.selected[0].facts.find(r => r.field === 'greeting').value = 'PRIVATE-INJECTION'; },
    p => { p.excluded[0].notes = 'PRIVATE-EXCLUDED'; },
  ];
  for (const mutate of mutations) {
    const altered = structuredClone(packet); mutate(altered);
    const { digest, ...body } = altered; altered.digest = factValueDigest(body);
    assert.throws(() => verifySelectedCohort(altered, f.policy, { now, expectedDigest: altered.digest }));
  }
});

test('policy and every persisted control row reject hidden notes and unknown keys', () => {
  const mutations = [
    p => { p.notes = 'PRIVATE-NOTE'; },
    p => { p.releases[0].notes = 'PRIVATE-RELEASE'; },
    p => { p.suppression[0].notes = 'PRIVATE-SUPPRESSION'; },
    p => { p.existingCustomerReviews = [{ recordId: 'mixed', disposition: 'historical_outreach_allowed', evidenceRef: 'review-ref', reviewedAt: stamp, notes: 'PRIVATE-REVIEW' }]; },
    p => { p.releases[0].classification = 'confidential'; },
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f.policy);
    assert.throws(() => select(f), /unavailable/);
  }
});

test('an unconverted flag cannot override a won-only history', () => {
 const f=fixture();f.snapshot.records[3].leadState='unconverted';
 const result=select(f);assert.equal(result.selected.some(r=>r.recordRef==='won'),false);
 assert.equal(result.holds.find(r=>r.recordRef==='won').reason,'stage_or_lead_state_unknown');
});
