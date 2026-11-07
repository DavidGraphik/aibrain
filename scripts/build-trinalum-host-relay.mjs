import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jobRoot = path.join(root, 'deployments/trinalum/host/cron/jobs');
const extract = async name => {
  const script = await readFile(path.join(jobRoot, name), 'utf8');
  const matches = [...script.matchAll(/cat <<'PROMPT'\n([\s\S]*?)\nPROMPT/g)];
  if (matches.length !== 1) throw Error('HOST_RELAY_POLICY_BUILD_FAILED');
  return matches[0][1];
};
const prefix = (await extract('sibema-event-router.sh')) + '\n\n' + (await extract('_openclaw_sibema_job.sh')) + '\n';
await build({ entryPoints: [path.join(root, 'deployments/trinalum/host/cron/lib/host-analysis-source.mjs')],
  outfile: path.join(root, 'dist/trinalum-host-analysis-source.mjs'), bundle: true, platform: 'node', format: 'esm',
  target: 'node24', legalComments: 'none', define: { __SIBEMA_ROUTER_PREFIX__: JSON.stringify(prefix) } });

const scripts = {};
for (const name of ['sibema-event-router.sh', '_openclaw_sibema_job.sh']) scripts[name] = createHash('sha256').update(await readFile(path.join(jobRoot, name))).digest('hex');
await writeFile(path.join(root, 'dist/trinalum-host-analysis-source-policy.json'), JSON.stringify({ schemaVersion: 1, installationId: 'trinalum-production', job: 'sibema-event-router', scripts }, null, 2) + '\n');
