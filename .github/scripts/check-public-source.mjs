import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
const paths = execFileSync('git', ['ls-files', '-z'], {encoding:'utf8'}).split('\0').filter(Boolean);
const problems = [];
const secret = /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/;
for (const path of paths) {
  if (/(^|\/)(?:node_modules|\.next|\.local-qa|preserved-server-archives)(?:\/|$)/.test(path) || /(?:^|\/)\.env(?!\.example$)/.test(path) || /\.(?:sqlite3?|key|p12|pfx)$/.test(path) || /config\/installations\/.*\.production\.json$/.test(path)) problems.push({path, reason:'private-or-generated-file'});
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) { problems.push({path,reason:'nonregular-source-object'}); continue; }
  const bytes = readFileSync(path);
  if (!bytes.includes(0) && secret.test(bytes.toString('utf8'))) problems.push({path, reason:'credential-shape'});
}
if (problems.length) { console.error(JSON.stringify({status:'FAIL',problems},null,2)); process.exit(1); }
console.log(JSON.stringify({status:'PASS',trackedFiles:paths.length,scope:'known credential shapes and private/generated paths; contextual review remains required'}));
