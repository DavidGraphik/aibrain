import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('native analysis bundles without client deployment files excluded from Docker', async () => {
  const result = await build({ absWorkingDir: root, entryPoints: ['scripts/host-analysis.ts', 'src/automations/host-analysis/input.ts'],
    outdir: '/virtual-host-packaging', bundle: true, write: false, metafile: true, platform: 'node', format: 'cjs', target: 'node24',
    conditions: ['react-server', 'node', 'require'], alias: { '@': path.join(root, 'src') },
    plugins: [{ name: 'excluded-client-context', setup(b) {
      b.onLoad({ filter: /(?:deployments[\\/]trinalum|infra[\\/]trinalum)[\\/]/ }, a => {
        throw Error('Reusable image must not depend on excluded client source: ' + path.relative(root, a.path));
      });
    } }],
  });
  assert.ok(result.metafile.inputs['infra/shared/automation-source-ids.mjs']);
  assert.ok(result.metafile.inputs['infra/shared/automation-read-policy.mjs']);
  assert.ok(result.metafile.inputs['infra/shared/validate-analysis.mjs']);
  assert.ok(result.outputFiles[0].contents.length > 1000);
});

test('container source contracts match the existing host contracts byte for byte', async () => {
  for (const name of ['automation-source-ids', 'automation-read-policy', 'validate-analysis']) {
    for (const suffix of ['.mjs', '.d.mts']) {
      assert.equal(await readFile(path.join(root, 'infra/shared', name + suffix), 'utf8'),
        await readFile(path.join(root, 'deployments/trinalum/host/cron/lib', name + suffix), 'utf8'));
    }
  }
});

test('container operator build does not invoke the privileged host relay builder', async () => {
  const script = await readFile(path.join(root, 'scripts/build-trinalum-operator-tools.mjs'), 'utf8');
  assert.doesNotMatch(script, /(?:import|require)\s*\(?\s*["']\.\/build-trinalum-host-relay\.mjs/);
  const ignored = await readFile(path.join(root, '.dockerignore'), 'utf8');
  assert.match(ignored, /^deployments$/m);
  assert.match(ignored, /^infra\/trinalum$/m);
});
