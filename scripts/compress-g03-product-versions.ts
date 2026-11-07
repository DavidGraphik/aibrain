/** Lossless, resumable history encoding. Defaults to planning; no retention. */
import {ProductStore} from '../src/g03-products/persistence';
async function main(){
const args=process.argv.slice(2),options=new Map<string,string>();let apply=false;
for(let i=0;i<args.length;i++){
 if(args[i]==='--apply'){apply=true;continue;}
 if(!['--root','--installation','--key','--limit'].includes(args[i])||!args[i+1]||options.has(args[i]))throw Error('Usage: --root ABSOLUTE_PRODUCT_ROOT --installation ID [--key production] [--limit N] [--apply]');
 options.set(args[i],args[++i]);
}
const root=options.get('--root'),installation=options.get('--installation');if(!root||!installation)throw Error('Explicit product root and installation are required.');
const store=new ProductStore(root,installation);
const results=await store.migrateVersions(options.get('--key')??'production',{apply,limit:options.has('--limit')?Number(options.get('--limit')):undefined,onResult:result=>{console.log(JSON.stringify(result));}});
console.log(JSON.stringify({complete:true,apply,files:results.length,originalBytes:results.reduce((sum,item)=>sum+item.originalBytes,0),compressedBytes:results.reduce((sum,item)=>sum+item.compressedBytes,0),savedBytes:results.reduce((sum,item)=>sum+item.savedBytes,0)}));

}
void main().catch(error=>{console.error(error instanceof Error?error.message:'Version migration failed');process.exitCode=1;});
