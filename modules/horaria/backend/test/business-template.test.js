import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('Meta first contact fails before sending without its approved template', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const { requireBusinessTemplate, nomIIdioma } = await import('./src/services/whatsapp.js');
    assert.throws(() => requireBusinessTemplate('broadcast'), /WHATSAPP_TEMPLATE_BROADCAST/);
    assert.throws(() => requireBusinessTemplate('schedule'), /WHATSAPP_TEMPLATE_HORARIO/);
    assert.deepEqual(nomIIdioma('solicitud_preferencies:ca'), { name: 'solicitud_preferencies', language: 'ca' });
  `], { cwd: new URL('../', import.meta.url), env: { ...process.env, WHATSAPP_MOCK: 'false', WHATSAPP_TOKEN: 'test-only-no-network-token', WHATSAPP_PROVIDER: 'meta', WHATSAPP_TEMPLATE_BROADCAST: '', WHATSAPP_TEMPLATE_HORARIO: '' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
