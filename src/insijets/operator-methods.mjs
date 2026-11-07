// Pure methods adapted from David insijets-website 6e391021 (first-version.mjs).
// Transport, CLI and synthetic-only builder are intentionally excluded.
const fail = code => {throw new Error(code);};
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
export function confidenceRating(lead, now) {
  if (!iso(now)) fail('INVALID_CLOCK');
  const date = Date.parse(now), verification = lead.verification;
  const fresh = verification?.status === 'valid' && iso(verification.checkedAt)
    && date-Date.parse(verification.checkedAt)>=0 && date-Date.parse(verification.checkedAt)<=7*86400000;
  let source = false;
  try {const u=new URL(lead.source?.url);source=u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash;} catch {}
  const dated = iso(lead.source?.checkedAt) && date-Date.parse(lead.source.checkedAt)>=0 && date-Date.parse(lead.source.checkedAt)<=90*86400000;
  const reasons=[];
  if(!fresh)reasons.push('verification missing, invalid, future or older than seven days');
  if(!source||!dated)reasons.push('dated public source missing or stale');
  if(lead.fitReviewed!==true)reasons.push('account and role fit not reviewed');
  return {rating:!reasons.length?'high':fresh&&source&&dated?'medium':'low',reasons,
    meaning:'Evidence completeness for operator review; not probability of charter intent.',
    pipelineReady:!reasons.length,source:source?lead.source.url:null,verification:fresh?'valid':'unconfirmed'};
}
const ratio=(n,d)=>d>0?n/d:null;
export function weeklyReadout(counts) {
  const keys=['attempted','delivered','hardBounces','readyRecords','duplicateRecords','principalDelivered','principalPositiveReplies','gatekeeperDelivered','gatekeeperPositiveReplies','acceptedLeads','providerCost','creditsUsed'];
  const c={};
  for(const key of keys){const v=counts[key];if(v===undefined||v===null)c[key]=null;else if(typeof v!=='number'||!Number.isFinite(v)||v<0)fail('INVALID_METRIC');else c[key]=v;}
  for(const [n,d] of [['delivered','attempted'],['hardBounces','attempted'],['duplicateRecords','readyRecords'],['principalPositiveReplies','principalDelivered'],['gatekeeperPositiveReplies','gatekeeperDelivered']])if(c[n]!==null&&c[d]!==null&&c[n]>c[d])fail('INCONSISTENT_METRIC');
  if(c.delivered!==null&&c.hardBounces!==null&&c.attempted!==null&&c.delivered+c.hardBounces>c.attempted)fail('INCONSISTENT_METRIC');
  const rate=(n,d)=>c[n]===null||c[d]===null?null:ratio(c[n],c[d]);
  return {mode:'offline-method-rehearsal',counts:c,hardBounceRate:rate('hardBounces','attempted'),duplicatePreparedRate:rate('duplicateRecords','readyRecords'),principalPositiveReplyRate:rate('principalPositiveReplies','principalDelivered'),gatekeeperPositiveReplyRate:rate('gatekeeperPositiveReplies','gatekeeperDelivered'),costPerAcceptedLead:rate('providerCost','acceptedLeads'),creditsPerAcceptedLead:rate('creditsUsed','acceptedLeads'),
    proposedDenominators:{hardBounce:'provider accepted send attempts',duplicates:'prepared batch; actual CRM duplicate rate needs client report',positiveReply:'delivered per persona',cost:'accepted verified leads'},
    definitionsApproval:false,liveResultsVerified:false,crmHistoricalRead:false};
}
export function triageReply({kind,requestId}) {
  if(!['positive','question','referral','negative','opt-out','out-of-office','unknown'].includes(kind)||typeof requestId!=='string'||!requestId)fail('INVALID_REPLY');
  return {requestId,kind,stopFollowups:true,suppressionRequired:kind==='opt-out',humanReviewRequired:true,
    preparedAlert:{state:'draft',channel:null,recipient:null,reason:kind},commercialReplySent:false,notificationSent:false};
}
export function dueContent(plan,now) {
  if(!iso(now)||!Array.isArray(plan)||plan.length>100)fail('INVALID_CALENDAR');
  return plan.filter(x=>{if(!iso(x.dueAt)||!['seo-review','newsletter-review'].includes(x.kind)||typeof x.id!=='string')fail('INVALID_CALENDAR_ITEM');return Date.parse(x.dueAt)<=Date.parse(now);}).map(x=>({id:x.id,kind:x.kind,dueAt:x.dueAt,state:'review-draft',publish:false,send:false}));
}
