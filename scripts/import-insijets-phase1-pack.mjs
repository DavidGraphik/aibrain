import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {importPhase1EditorialPack} from '../src/insijets/outreach-editorial-import.ts';
const [source,output]=process.argv.slice(2);if(!source||!output)throw Error('Usage: node --experimental-strip-types scripts/import-insijets-phase1-pack.mjs SOURCE_JSON OUTPUT_FOLDER');
const raw=readFileSync(source,'utf8'),configuration=importPhase1EditorialPack(raw);mkdirSync(output,{recursive:true});
writeFileSync(path.join(output,'phase1-config.json'),JSON.stringify(configuration,null,2)+'\n');
writeFileSync(path.join(output,'normalized-campaigns.json'),JSON.stringify(configuration.campaigns,null,2)+'\n');
writeFileSync(path.join(output,'editorial-parity.json'),JSON.stringify({sourcePath:path.resolve(source),sourceSha256:configuration.sourceSha256,configurationVersion:configuration.configurationVersion,...configuration.parity},null,2)+'\n');
console.log(JSON.stringify({sourceSha256:configuration.sourceSha256,configurationVersion:configuration.configurationVersion,campaigns:configuration.campaigns.length,messages:configuration.parity.messages,allIdentical:configuration.parity.allIdentical,sendEnabled:false}));
