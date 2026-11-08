// Run by the InsiJets custodian in its own protected environment, never by AI.
import {readFileSync,lstatSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {selectClientCohort} from './client-selection.mjs';
const read=file=>{const s=lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.size>20*1024*1024)throw Error('input_denied');return JSON.parse(readFileSync(file,'utf8'));};
try{
 const args=process.argv.slice(2);
 if(args.length===1&&args[0]==='--help')console.log('node client-selection-cli.mjs NORMALIZED_SNAPSHOT.json CLIENT_POLICY.json SERVER_BINDING.json NEW_CONTROL.json\nClient-local only, no network/credentials. Outputs private minimal selection plus policy, never raw notes. Does not activate CRM.');
 else{
  if(args.length!==4)throw Error('arguments_denied');
  const [source,policyFile,bindingFile,out]=args,policy=read(policyFile),binding=read(bindingFile);
  const keys=['version','tenantId','clientId','gatewayOrigin','acceptanceEvidenceRef','authorizedUserIds','metadata'];
  if(!binding||Object.keys(binding).length!==keys.length||keys.some(k=>!Object.hasOwn(binding,k))||binding.version!==1||binding.tenantId!=='insijets-demo'||binding.clientId!=='insijets-outreach')throw Error('binding_denied');
  const packet=selectClientCohort(read(source),policy);
  if(packet.selected.length>100)throw Error('pilot_bound_exceeded');
  const control={...binding,policy,packet,expectedSelectionDigest:packet.digest};
  const raw=JSON.stringify(control,null,2)+'\n';
  writeFileSync(out,raw,{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({status:'client-local-selection-only',selected:packet.selected.length,held:packet.holds.length,excluded:packet.excluded.length,controlSha256:createHash('sha256').update(raw).digest('hex'),networkEnabled:false,activation:false}));
 }
}catch{console.error('Client selection preparation failed; inspect local inputs. Existing output was not overwritten. No provider was contacted.');process.exitCode=1;}
