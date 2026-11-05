import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const tests = JSON.parse(readFileSync(new URL('../quality-tests.json', import.meta.url), 'utf8'));
if (!Array.isArray(tests) || !tests.length || tests.some(p => typeof p !== 'string' || !/^(src|tests)\//.test(p) || p.includes('..'))) throw Error('Invalid quality suite manifest');
const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...tests, '--maxWorkers=1'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
