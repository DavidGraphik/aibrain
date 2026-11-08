import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validQualityManifest } from './run-quality-tests.mjs';

test('accepts the committed bank, including Next dynamic and catch-all route files', () => {
  assert.equal(validQualityManifest(JSON.parse(readFileSync(new URL('../quality-tests.json', import.meta.url), 'utf8'))), true);
  assert.equal(validQualityManifest(['src/app/api/[resourceId]/route.test.ts', 'src/app/api/[[...nativePath]]/route.test.ts']), true);
});
test('rejects traversal components, alternative separators, controls and paths outside source/tests', () => {
  for (const path of ['src/../outside.test.ts', 'src/a/../../outside.test.ts', 'src/./a.test.ts', 'src//a.test.ts',
    'src/a\\..\\outside.test.ts', 'src/a\u0000.test.ts', '/src/a.test.ts', 'scripts/a.test.ts']) {
    assert.equal(validQualityManifest([path]), false, path);
  }
});
test('rejects an empty or malformed manifest', () => {
  for (const value of [[], null, {}, 'src/a.test.ts', [42], [null]]) assert.equal(validQualityManifest(value), false);
});
