import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function validQualityManifest(tests) {
  return Array.isArray(tests) && tests.length > 0 && tests.every(p => typeof p === 'string'
    && /^(src|tests)\//.test(p) && !/[\\\u0000-\u001f\u007f]/.test(p)
    && !p.split('/').some(part => !part || part === '.' || part === '..'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tests = JSON.parse(readFileSync(new URL('../quality-tests.json', import.meta.url), 'utf8'));
  if (!validQualityManifest(tests)) throw Error('Invalid quality suite manifest');
  const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...tests, '--maxWorkers=1'], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
