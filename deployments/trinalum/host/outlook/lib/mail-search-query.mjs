const normalize = value => String(value ?? '').normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('es').replace(/\s+/g, ' ').trim();
// Lookup presentation only. Preserve every identifier character; original
// message identity and provider date grammar keep their separate exact checks.
export const normalizeMailSearchText=value=>normalize(value).replace(/[\u2010-\u2015\u2212]/g,'-').replace(/\s*([-:()/])\s*/g,'$1');
const invalid = () => Object.assign(new Error('Invalid or unsupported mailbox search query'), {code:'MAIL_SEARCH_QUERY_INVALID'});

// Explicit reference selectors tolerate optional single spaces around each
// separator. Every branch retains all identifier characters and their order;
// this is not a bag-of-words fallback or a rewrite of literal TEXT/SUBJECT.
export function mailReferenceSearchVariants(value) {
  if(typeof value!=='string'||value.length>96||!/[\p{N}]/u.test(value)||
    !/^[\p{L}\p{N}]+(?: *[-\u2010-\u2015\u2212:/.\u005f] *[\p{L}\p{N}]+)*$/u.test(value))throw invalid();
  const pieces=value.split(/ *([-\u2010-\u2015\u2212:/.\u005f]) */u);
  if(pieces.length>7)throw invalid();
  let variants=[pieces[0]];
  for(let i=1;i<pieces.length;i+=2)variants=variants.flatMap(prefix=>['',' '].flatMap(left=>['',' '].map(right=>prefix+left+pieces[i]+right+pieces[i+1])));
  const result=[...new Set([value,...variants])];
  if(result.length>64)throw invalid();
  return result;
}

// A bounded, data-only grammar. No regex, shell or provider query is evaluated.
export function compileMailSearchQuery(query) {
  if(typeof query!=='string'||query.length>500||!query.trim())throw invalid();
  const tokens=[];let at=0;
  while(at<query.length){
    if(/\s/.test(query[at])){at++;continue;}
    if('()'.includes(query[at])){tokens.push({value:query[at++],group:true});continue;}
    let value='',quoted=false;const fullyQuoted='"\'“‘'.includes(query[at]);
    while(at<query.length&&!/\s|[()]/.test(query[at])){
      const open=query[at],close=new Map([['"','"'],["'","'"],['“','”'],['‘','’']]).get(open);
      if(close){
        at++;quoted=true;let closed=false;
        while(at<query.length){
          if(query[at]===close){at++;closed=true;break;}
          if(query[at]==='\\'&&at+1<query.length)at++;
          value+=query[at++];
        }
        if(!closed)throw invalid();
      }else value+=query[at++];
    }
    if(!value.trim())throw invalid();
    tokens.push({value,quoted,fullyQuoted});if(tokens.length>64)throw invalid();
  }
  if(!tokens.length||tokens.length>64)throw invalid();
  let index=0;
  const operator=word=>tokens[index]?.value===word&&!tokens[index].quoted&&!tokens[index].group;
  // Field inheritance is local to each group; explicit terms retain their own field.
  function term(depth,defaultField='text'){
    if(depth>4)throw invalid();
    const token=tokens[index++];if(!token)throw invalid();
    if(token.group){
      if(token.value!=='(')throw invalid();
      const inside=or(depth+1,defaultField);if(tokens[index++]?.value!==')')throw invalid();return inside;
    }
    if(!token.quoted&&['AND','OR'].includes(token.value))throw invalid();
    const colon=token.fullyQuoted?-1:token.value.indexOf(':');
    let field=colon<0?defaultField:token.value.slice(0,colon).toLowerCase();
    const needle=normalize(colon<0?token.value:token.value.slice(colon+1));
    if(!needle&&colon>=0&&tokens[index]?.group&&tokens[index].value==='('){
      if(!['text','subject','from','to'].includes(field))throw invalid();
      index++;const grouped=or(depth+1,field);if(tokens[index++]?.value!==')')throw invalid();return grouped;
    }
    let referenceNeedles=null;
    if(field==='reference'||field==='subject_reference'){
      referenceNeedles=mailReferenceSearchVariants(colon<0?token.value:token.value.slice(colon+1)).map(value=>value.toLocaleLowerCase('es'));
      field=field==='reference'?'text':'subject';
    }
    if(!needle||!['text','subject','from','to','after','before'].includes(field))throw invalid();
    if(field==='after'||field==='before'){
      if(!/^\d{4}-\d{2}-\d{2}$/.test(needle))throw invalid();
      const timestamp=Date.parse(needle+'T00:00:00Z');
      if(!Number.isFinite(timestamp)||new Date(timestamp).toISOString().slice(0,10)!==needle)throw invalid();
      return message=>field==='after'?message.date.getTime()>=timestamp:message.date.getTime()<timestamp;
    }
    const lookupNeedle=normalizeMailSearchText(needle);
    return message=>{
      const addresses=items=>{const list=Array.isArray(items)?items:Array.isArray(items?.value)?items.value:items?[items]:[];return list.map(item=>{const x=item?.emailAddress??item??{};return `${x.name??''} ${x.address??''}`;}).join(' ');};
      const values={subject:message.data.subject,from:addresses(message.from),to:addresses(message.data.toRecipients??message.externalRecipients)};
      const haystack=field==='text'?[message.data.subject,message.data.text,values.from,values.to].join(' '):values[field];
      if(referenceNeedles)return referenceNeedles.some(value=>String(haystack??'').toLocaleLowerCase('es').includes(value));
      return normalizeMailSearchText(haystack).includes(lookupNeedle);
    };
  }
  function and(depth,defaultField){
    const parts=[term(depth,defaultField)];
    while(index<tokens.length&&!operator('OR')&&tokens[index].value!==')'){
      if(operator('AND'))index++;
      parts.push(term(depth,defaultField));
    }
    return message=>parts.every(test=>test(message));
  }
  function or(depth,defaultField){
    const parts=[and(depth,defaultField)];while(operator('OR')){index++;parts.push(and(depth,defaultField));}
    return message=>parts.some(test=>test(message));
  }
  const match=or(0);if(index!==tokens.length)throw invalid();return match;
}
