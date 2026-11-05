export function registrationPageFromCli(value,path){
 if(!value||value.source!=='SIBEMA'||value.path!==path||!value.data||typeof value.data!=='object'||Array.isArray(value.data))throw Error('UNVERIFIED_SOURCE_RESPONSE');
 return value.data;
}
// Additional named-company read coverage using only an actor's existing ERP scope.
export async function registrationCoverage(query, read) {
 const checkedAt=new Date().toISOString();
 const unavailable=reason=>({query,checked_at:checkedAt,complete:false,reason,customers:null,providers:null});
 if(typeof query!=='string'||!query.trim()||query.length>100||query.includes(' OR ')||/[|;]/.test(query)||/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(query.trim()))return unavailable('A bounded individual company-name or alias query is required; a domain-only or compound search does not certify ERP absence.');
 const result={query,checked_at:checkedAt,complete:true,matching_scope:'Native ERP name search for this exact query only; verify every known legal name/brand separately. Empty results are not proof against unknown aliases.',customers:null,providers:null};
 for(const [resource,key]of [['customers','customer_id'],['providers','provider_id']]){
  const rows=[],seen=new Set();let complete=false,error=null;
  try{
   for(let page=0;page<10;page++){
    const path=`/${resource}?search=${encodeURIComponent(query)}&page=${page}&size=200`;
    if(path.length>150)throw Error('QUERY_TOO_LONG');
    const value=await read(path);
    if(!Array.isArray(value?.data)||value.data.length>200||typeof value.has_next!=='boolean')throw Error('UNVERIFIED_PAGINATION');
    for(const item of value.data){
     if(!Number.isSafeInteger(item[key])||seen.has(item[key]))throw Error('INCONSISTENT_IDENTITIES');
     seen.add(item[key]);rows.push({[key]:item[key],name:item.name,commercial_name:item.commercial_name,vat_number:item.vat_number??null,address:item.address??null,cross_system_identity_verified:false});
    }
    if(!value.has_next){complete=true;break;}
   }
   if(!complete)error='BOUNDED_PAGINATION_INCOMPLETE';
  }catch(e){error=['QUERY_TOO_LONG','UNVERIFIED_PAGINATION','INCONSISTENT_IDENTITIES','UNVERIFIED_SOURCE_RESPONSE'].includes(e?.message)?e.message:'SOURCE_UNAVAILABLE';}
  result[resource]={complete,possible_matches:rows,possible_match_count:rows.length,error};
  if(!complete)result.complete=false;
 }
 return result;
}
