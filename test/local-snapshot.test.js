import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { openCodeKeyPath, readLocalSnapshot } from '../src/local-snapshot.js';

test('extracts portable values without leaking configuration credentials', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sync-snapshot-'));
  const openChamberDir = path.join(root, 'chamber');
  const openCodeDir = path.join(root, 'code');
  try {
    await mkdir(openChamberDir);
    await mkdir(openCodeDir);
    await writeFile(path.join(openChamberDir, 'preferences.json'), JSON.stringify({
      version: 1, fields: { darkThemeId: 'dark', relaySecret: 'do-not-export' },
    }));
    await writeFile(path.join(openCodeDir, 'opencode.json'), JSON.stringify({
      model: 'provider/model', provider: { example: { apiKey: 'do-not-export' } },
    }));
    await writeFile(path.join(openChamberDir, 'extensions.json'), JSON.stringify({
      gitOrigins: { one: { url: 'https://example.com/repo.git' } },
    }));

    const snapshot = await readLocalSnapshot({ openChamberDir, openCodeDir });
    assert.equal(snapshot.sources.preferences.status, 'ready');
    assert.equal(snapshot.values['preferences.darkThemeId'], 'dark');
    assert.equal(snapshot.values[openCodeKeyPath('model')], 'provider/model');
    assert.deepEqual(snapshot.values[openCodeKeyPath('provider')], { example: {} });
    assert.deepEqual(snapshot.values['extensions.repositories'], ['https://example.com/repo.git']);
    assert.doesNotMatch(JSON.stringify(snapshot), /do-not-export|relaySecret/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('distinguishes missing from invalid or symlinked sources', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sync-snapshot-'));
  const openChamberDir = path.join(root, 'chamber');
  const openCodeDir = path.join(root, 'code');
  try {
    await mkdir(openChamberDir);
    await mkdir(openCodeDir);
    await writeFile(path.join(openChamberDir, 'preferences.json'), '{broken');
    await symlink(path.join(openChamberDir, 'preferences.json'), path.join(openCodeDir, 'opencode.json'));
    const snapshot = await readLocalSnapshot({ openChamberDir, openCodeDir });
    assert.equal(snapshot.sources.preferences.status, 'unavailable');
    assert.equal(snapshot.sources.opencode.status, 'unavailable');
    assert.equal(snapshot.sources.extensions.status, 'missing');
    assert.deepEqual(snapshot.values, {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preserves OpenCode keys that do not fit the sync key-path grammar', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sync-snapshot-'));
  try {
    await writeFile(path.join(root, 'opencode.json'), JSON.stringify({ '$schema': 'https://example.com/schema', 'key.with.dot': true }));
    const snapshot = await readLocalSnapshot({ openChamberDir: root, openCodeDir: root });
    assert.equal(snapshot.sources.opencode.status, 'ready');
    assert.equal(snapshot.values[openCodeKeyPath('$schema')], 'https://example.com/schema');
    assert.equal(snapshot.values[openCodeKeyPath('key.with.dot')], true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses OpenCode keys that cannot be encoded losslessly', () => {
  assert.throws(() => openCodeKeyPath('\ud800'), /key/i);
});

test('snapshots only allowlisted OpenCode instruction and plugin files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sync-snapshot-'));
  const openChamberDir = path.join(root, 'chamber');
  const openCodeDir = path.join(root, 'code');
  try {
    await mkdir(openChamberDir);
    await mkdir(path.join(openCodeDir, 'agents', 'team'), { recursive: true });
    await mkdir(path.join(openCodeDir, 'commands'), { recursive: true });
    await mkdir(path.join(openCodeDir, 'skills', 'review'), { recursive: true });
    await mkdir(path.join(openCodeDir, 'plugins', 'example'), { recursive: true });
    await mkdir(path.join(openCodeDir, 'plugins', 'example', 'node_modules', 'private'), { recursive: true });
    await mkdir(path.join(openCodeDir, 'plugins', 'example', '.git'), { recursive: true });
    await writeFile(path.join(openCodeDir, 'agents', 'team', 'review.md'), 'Use small, explicit changes.');
    await writeFile(path.join(openCodeDir, 'commands', 'check.json'), '{"name":"check"}');
    await writeFile(path.join(openCodeDir, 'skills', 'review', 'SKILL.md'), 'Review changes carefully.');
    await writeFile(path.join(openCodeDir, 'plugins', 'example', 'index.ts'), 'export const plugin = true;');
    await writeFile(path.join(openCodeDir, 'skills', 'review', '.env'), 'TOKEN=must-not-sync');
    await writeFile(path.join(openCodeDir, 'agents', 'team', 'notes.csv'), 'not,portable');
    await writeFile(path.join(openCodeDir, 'plugins', 'example', 'node_modules', 'private', 'payload.js'), 'must-not-sync');
    await writeFile(path.join(openCodeDir, 'plugins', 'example', '.git', 'config'), 'must-not-sync');

    const snapshot = await readLocalSnapshot({ openChamberDir, openCodeDir });
    const fileValues = Object.entries(snapshot.values).filter(([key]) => key.startsWith('opencodeFile.'));
    assert.equal(snapshot.sources['opencode-files'].status, 'ready');
    assert.equal(fileValues.length, 4);
    assert.deepEqual(fileValues.map(([, value]) => value).sort(), [
      'Review changes carefully.',
      'Use small, explicit changes.',
      'export const plugin = true;',
      '{"name":"check"}',
    ]);
    assert.doesNotMatch(JSON.stringify(snapshot), /must-not-sync|not,portable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('blocks the OpenCode file source when an allowlisted file looks credential-bearing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sync-snapshot-'));
  const openChamberDir = path.join(root, 'chamber');
  const openCodeDir = path.join(root, 'code');
  try {
    await mkdir(openChamberDir);
    await mkdir(path.join(openCodeDir, 'agents'), { recursive: true });
    await writeFile(path.join(openCodeDir, 'agents', 'private.md'), 'Set api_key = "ghp_123456789012345678901234567890123456"');

    const snapshot = await readLocalSnapshot({ openChamberDir, openCodeDir });
    assert.equal(snapshot.sources['opencode-files'].status, 'unavailable');
    assert.equal(Object.keys(snapshot.values).some((key) => key.startsWith('opencodeFile.')), false);
    assert.doesNotMatch(JSON.stringify(snapshot), /ghp_123456/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('blocks allowlisted files with credential-oriented names', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sync-snapshot-'));
  const openChamberDir = path.join(root, 'chamber');
  const openCodeDir = path.join(root, 'code');
  try {
    await mkdir(openChamberDir);
    await mkdir(path.join(openCodeDir, 'plugins'), { recursive: true });
    await writeFile(path.join(openCodeDir, 'plugins', 'api_key.json'), '{"value":"do-not-read"}');
    const snapshot = await readLocalSnapshot({ openChamberDir, openCodeDir });
    assert.equal(snapshot.sources['opencode-files'].status, 'unavailable');
    assert.doesNotMatch(JSON.stringify(snapshot), /do-not-read/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('blocks rather than following OpenCode file symlinks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sync-snapshot-'));
  const openChamberDir = path.join(root, 'chamber');
  const openCodeDir = path.join(root, 'code');
  try {
    await mkdir(openChamberDir);
    await mkdir(path.join(openCodeDir, 'skills'), { recursive: true });
    await writeFile(path.join(root, 'outside.md'), 'must-not-read');
    await symlink(path.join(root, 'outside.md'), path.join(openCodeDir, 'skills', 'external.md'));

    const snapshot = await readLocalSnapshot({ openChamberDir, openCodeDir });
    assert.equal(snapshot.sources['opencode-files'].status, 'unavailable');
    assert.equal(Object.keys(snapshot.values).some((key) => key.startsWith('opencodeFile.')), false);
    assert.doesNotMatch(JSON.stringify(snapshot), /must-not-read/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not snapshot structured OpenCode values with credentials embedded in strings', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sync-snapshot-'));
  const openChamberDir = path.join(root, 'chamber');
  const openCodeDir = path.join(root, 'code');
  try {
    await mkdir(openChamberDir);
    await mkdir(openCodeDir);
    await writeFile(path.join(openCodeDir, 'opencode.json'), JSON.stringify({
      model: 'provider/model',
      mcp: { local: { command: 'curl https://user:private-password@example.invalid/mcp' } },
    }));

    const snapshot = await readLocalSnapshot({ openChamberDir, openCodeDir });
    assert.equal(snapshot.sources.opencode.status, 'unavailable');
    assert.equal(Object.keys(snapshot.values).some((key) => key.startsWith('opencode.')), false);
    assert.doesNotMatch(JSON.stringify(snapshot), /user:private-password/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
