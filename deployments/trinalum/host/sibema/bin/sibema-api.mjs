#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {discover,schemaFor} from '../lib/api-contract.mjs';
import {readApi} from '../lib/api-request.mjs';
import {SibemaClient} from '../lib/sibema-client.mjs';
import {readProductCatalog} from '../lib/offer-reference-lines.mjs';
try{
 const [command,...args]=process.argv.slice(2);
 let actor;const actorIndex=args.indexOf('--actor');
 if(actorIndex!==-1){if(command!=='read'||actorIndex!==args.length-2)throw Error('Trusted actor suffix required');actor=args[actorIndex+1];args.splice(actorIndex,2);}
 let input={};
 if(args.length){if(args.length!==2||!['--input','--json'].includes(args[0])||(args[0]==='--input'&&!args[1].startsWith('/')))throw Error('Expected --input ABSOLUTE_FILE or --json JSON');const data=args[0]==='--json'?Buffer.from(args[1]):await readFile(args[1]);if(data.length>8192)throw Error('Read/discovery input exceeds 8KB');input=JSON.parse(data.toString('utf8'));}
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Input must be object');
 let output;
 if(command==='discover'){if(Object.keys(input).length)throw Error('discover takes no arguments');output=discover();}
 else if(command==='catalog'){output=await readProductCatalog(new SibemaClient(),input);}
 else if(command==='schema'){if(Object.keys(input).some(k=>!['method','path'].includes(k)))throw Error('Unknown schema argument');output=schemaFor(input.method??'GET',input.path);}
 else if(command==='read')output=await readApi(new SibemaClient(),input,{actor});
 else throw Error('Usage: sibema-api.mjs discover | schema --input FILE | read --input FILE');
 console.log(JSON.stringify(output));
}catch(error){console.error(JSON.stringify({status:'error',code:error.code??null,httpStatus:error.status??null,message:error.message}));process.exitCode=1;}
