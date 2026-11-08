/** Local, read-only inventory shortlist. This module has no send/network capability.
 * Published fleet observations never establish availability, price or airworthiness.
 * The caller must enforce InsiJets identity/tenant authorization before loading data.
 */
const normalized = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value || '');
const isJet = value => /jet/i.test(value || '') && !/helicopter/i.test(value || '');

/** Small deterministic local demo parser. Ambiguous cities require airport confirmation. */
export function parseFlightEnquiry(text) {
  const value=normalized(text), codes=String(text).match(/\b[A-Z]{4}\b/g)||[];
  const passengers=Number((value.match(/(\d+)\s*(?:passengers|pasajeros|pax|personas)/)||[])[1])||null;
  const knownCities=/paris/.test(value)&&/genev[ae]|ginebra|geneve/.test(value);
  return {originAirport:codes[0]||null,destinationAirport:codes[1]||null,passengers,originCity:knownCities?'Paris':null,suggestedAirports:knownCities&&codes.length<2?['LFPB (Paris Le Bourget)','LSGG (Geneva)']:[],missingInputs:[...(codes.length<2?['Confirm departure and destination airports']:[]),...(!passengers?['Passenger count']:[]),'Departure date, time and time zone','Return flight or one-way','Sending mailbox']};
}

export function shortlistAircraft(dataset, request, {limit = 20} = {}) {
  if (!request || !/^[A-Z0-9]{3,4}$/.test(request.originAirport || '') || !/^[A-Z0-9]{3,4}$/.test(request.destinationAirport || '') || request.originAirport === request.destinationAirport)
    throw new Error('Two distinct explicit airport codes are required.');
  if (!Number.isSafeInteger(request.passengers) || request.passengers < 1 || request.passengers > 500) throw new Error('A positive passenger count is required.');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 300) throw new Error('Shortlist limit must be 1–300.');
  if (request.repositionCountries !== undefined && (!Array.isArray(request.repositionCountries) || request.repositionCountries.length > 20 || request.repositionCountries.some(x => typeof x !== 'string' || x.length > 100))) throw new Error('Repositioning countries must be an explicit list.');
  for (const key of ['reference','originCity','flightType','departureISO','timeZone','sender']) if (request[key] != null && (typeof request[key] !== 'string' || request[key].length > 200 || /[\u0000-\u001f]/.test(request[key]))) throw new Error('Invalid request text.');
  const operators = new Map(dataset.operators.map(row => [row.id, row]));
  const bases = new Map(dataset.bases.map(row => [row.id, row]));
  const contacts = dataset.contacts.filter(row => !row.suppressed && validEmail(row.email));
  const candidateGroups = new Map();
  for (const aircraft of dataset.aircraft) {
    if (!isJet(aircraft.category) || !Number.isSafeInteger(aircraft.seats) || aircraft.seats < request.passengers) continue;
    const base = bases.get(aircraft.base_id), operator = operators.get(aircraft.operator_id);
    if (!base || !operator || base.operator_id !== operator.id) continue;
    const origin = base.airport === request.originAirport;
    const arrival = base.airport === request.destinationAirport;
    const sameCity = request.originCity && normalized(base.city) === normalized(request.originCity);
    const nearbyCountry = (request.repositionCountries || []).includes(base.country);
    if (!(origin || arrival || sameCity || nearbyCountry)) continue;
    // Exact group association only. Unknown/company-only contacts need separate review.
    const emails = [...new Set(contacts.filter(row => row.operator_id === operator.id && row.base_id === base.id).map(row => row.email.toLowerCase()))].sort();
    if (!emails.length) continue;
    const tier = origin ? 0 : sameCity ? 1 : arrival ? 2 : 3;
    const key = operator.id + '|' + base.id;
    const candidate = candidateGroups.get(key) || {operatorId:operator.id,operator:operator.name,baseId:base.id,airport:base.airport,country:base.country,city:base.city,tier,reason:origin?'Published departure-airport base':sameCity?'Published departure-city base':arrival?'Published destination-airport base; positioning required':'Published base in explicitly allowed repositioning country',emails,aircraft:[],availability:'Unconfirmed. Operator reply required.',routeFeasibility:'Not assessed. Range, airport performance, permissions, crew and slots require operator confirmation.'};
    candidate.aircraft.push({id:aircraft.id,model:aircraft.model,seats:aircraft.seats,sourceURL:aircraft.source_url,checkedAt:aircraft.checked_at});
    candidateGroups.set(key,candidate);
  }
  return [...candidateGroups.values()].sort((a,b)=>a.tier-b.tier || a.operator.localeCompare(b.operator) || a.baseId.localeCompare(b.baseId)).slice(0,limit);
}

export function prepareAvailabilityDrafts(shortlist, request) {
  const missing = ['sender','departureISO','timeZone'].filter(key=>!request[key]);
  if (request.sender && !validEmail(request.sender)) missing.push('valid sender');
  if (request.departureISO && !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d)$/.test(request.departureISO)) missing.push('departure with explicit UTC offset');
  const drafts = [], seen = new Set();
  for (const candidate of shortlist) for (const email of candidate.emails) {
    if (seen.has(email)) continue;
    seen.add(email);
    const subject = `[${request.reference || 'REFERENCE REQUIRED'}] Availability request: ${request.originAirport}–${request.destinationAirport}`;
    const body = `Dear ${candidate.operator} team,\n\nCould you please confirm aircraft availability for the following enquiry?\n\nRoute: ${request.originAirport} to ${request.destinationAirport}\nDeparture: ${request.departureISO || 'DATE AND TIME REQUIRED'} (${request.timeZone || 'TIME ZONE REQUIRED'})\nPassengers: ${request.passengers}\nFlight type: ${request.flightType || 'One-way; please confirm'}\n\nPlease provide your available aircraft, registration, seating, positioning requirements, all-inclusive quote and currency, validity, cancellation terms, and any airport or operational restrictions. Please confirm that the operating carrier holds the required authorisations and insurance.\n\nKind regards,\nExample Representative\nInsiJets`;
    drafts.push({operatorId:candidate.operatorId,sender:request.sender||null,to:[email],cc:[],bcc:[],subject,body,attachments:[],status:'LOCAL DRAFT. NOT SENT.',requiresDavidApproval:true,approval:null,graphDraftPayload:{subject,body:{contentType:'Text',content:body},toRecipients:[{emailAddress:{address:email}}],ccRecipients:[],bccRecipients:[]}});
  }
  return {request,missingInputs:missing,sendEnabled:false,blockers:[...missing.map(x=>'Missing '+x),'Outlook OAuth and mailbox permissions have not been verified.','David must approve each exact final email, sender, recipients and attachments before send.'],drafts};
}
