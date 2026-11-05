// Structured constraints preserve the complete human lookup in one query.
// Existing literal query callers retain their exact semantics and cursor keys.
export function mailSearchIntentQuery(input){
 const fail=()=>{throw Object.assign(Error('Invalid structured mailbox search'),{code:'MAIL_SEARCH_INTENT_INVALID'});};
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['reference','referenceIn','companies','from','to','subject','text','after','before'].includes(key)))fail();
 const quote=value=>{if(typeof value!=='string'||!value.trim()||value!==value.trim()||value.length>160||/[\x00-\x1f\x7f]/.test(value))fail();return '"'+value.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"';};
 const parts=[];
 if(input.referenceIn!==undefined&&!['text','subject'].includes(input.referenceIn)||input.referenceIn!==undefined&&input.reference===undefined)fail();
 if(input.reference!==undefined)parts.push((input.referenceIn==='subject'?'subject_reference:':'reference:')+quote(input.reference));
 if(input.companies!==undefined){if(!Array.isArray(input.companies)||input.companies.length<1||input.companies.length>6)fail();for(const value of input.companies)parts.push('text:'+quote(value));}
 for(const key of ['from','to','subject','text'])if(input[key]!==undefined)parts.push(key+':'+quote(input[key]));
 for(const key of ['after','before'])if(input[key]!==undefined){const value=input[key];if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)fail();parts.push(key+':'+value);}
 if(input.after&&input.before&&input.after>=input.before)fail();
 const query=parts.join(' AND ');if(!query||query.length>1000)fail();return query;
}
