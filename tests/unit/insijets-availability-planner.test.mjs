import test from 'node:test';
import assert from 'node:assert/strict';
import {shortlistAircraft,prepareAvailabilityDrafts} from '../../src/insijets/availability-planner.mjs';
const req={originAirport:'LFPB',destinationAirport:'LSGG',passengers:6,originCity:'Paris'};
const data={operators:[{id:'op',name:'Real source operator'}],bases:[{id:'b',operator_id:'op',airport:'LFPB',city:'Paris',country:'France'}],aircraft:[{id:'a',operator_id:'op',base_id:'b',category:'Light Jet',seats:7,model:'Published model'}],contacts:[{operator_id:'op',base_id:'b',email:'ops@example.invalid'}]};
test('uses known seats and exact operator/base contacts, without availability claims',()=>{
  const result=shortlistAircraft(data,req);assert.equal(result.length,1);assert.match(result[0].availability,/Unconfirmed/);
  for(const altered of [{...data,aircraft:[{...data.aircraft[0],seats:null}]},{...data,aircraft:[{...data.aircraft[0],seats:5}]},{...data,contacts:[{...data.contacts[0],operator_id:'someone-else'}]},{...data,contacts:[{...data.contacts[0],base_id:'other-base'}]},{...data,contacts:[{...data.contacts[0],suppressed:true}]}])assert.equal(shortlistAircraft(altered,req).length,0);
});
test('requires explicit airports and deduplicates local drafts while keeping send disabled',()=>{
  assert.throws(()=>shortlistAircraft(data,{...req,destinationAirport:'LFPB'}));
  const shortlist=shortlistAircraft(data,req);const draft=prepareAvailabilityDrafts([...shortlist,...shortlist],req);
  assert.equal(draft.drafts.length,1);assert.equal(draft.sendEnabled,false);assert.equal(draft.drafts[0].approval,null);assert(draft.blockers.some(x=>x.includes('David')));assert(draft.missingInputs.includes('sender'));
});
