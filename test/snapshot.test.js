import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeOpenCodeConfig, selectPortablePreferences } from '../src/snapshot.js';

test('selects only known portable preference fields', () => {
  const source = {
    version: 1,
    fields: {
      darkThemeId: 'midnight',
      favoriteModels: ['provider/model'],
      activeProjectId: 'machine-local-project',
      relaySigningKey: 'must-not-sync',
      futurePreference: 'unknown',
    },
    localOnly: 'must-not-sync',
  };

  assert.deepEqual(selectPortablePreferences(source), {
    version: 1,
    fields: {
      darkThemeId: 'midnight',
      favoriteModels: ['provider/model'],
    },
  });
});

test('rejects malformed preference envelopes', () => {
  assert.throws(() => selectPortablePreferences(null), /preferences object/i);
  assert.throws(() => selectPortablePreferences({ version: 1, fields: [] }), /fields object/i);
});

test('strips credentials and environment/header values from OpenCode config', () => {
  const source = {
    $schema: 'https://example.invalid/opencode.json',
    model: 'provider/model',
    provider: {
      apiKey: 'literal-api-key',
      options: {
        headers: { Authorization: 'Bearer literal-token' },
        timeout: 1000,
      },
      env: { PROVIDER_TOKEN: 'literal-env-secret' },
    },
    mcp: { 'local-tool': { command: 'node', password: 'literal-password' } },
  };

  const safe = sanitizeOpenCodeConfig(source);
  const serialized = JSON.stringify(safe);

  assert.deepEqual(safe, {
    $schema: 'https://example.invalid/opencode.json',
    model: 'provider/model',
    provider: { options: { timeout: 1000 } },
    mcp: { 'local-tool': { command: 'node' } },
  });
  assert.doesNotMatch(serialized, /literal-(?:api-key|token|env-secret|password)/);
});

test('removes credentials embedded in endpoint URLs', () => {
  const safe = sanitizeOpenCodeConfig({
    provider: {
      options: {
        baseURL: 'https://user:password@example.invalid/v1?api_key=query-secret&region=eu',
      },
    },
  });

  assert.equal(safe.provider.options.baseURL, 'https://example.invalid/v1?region=eu');
});

test('omits prototype-manipulation keys while sanitizing', () => {
  const source = JSON.parse('{"safe":1,"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}');

  assert.deepEqual(sanitizeOpenCodeConfig(source), { safe: 1 });
  assert.equal({}.polluted, undefined);
});
