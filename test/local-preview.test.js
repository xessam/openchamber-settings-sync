import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createLocalPreview } from '../src/local-preview.js';

test('reports portable item counts without returning local config values', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openchamber-sync-'));
  const openChamberDir = path.join(root, 'openchamber');
  const openCodeDir = path.join(root, 'opencode');
  await mkdir(openChamberDir);
  await mkdir(openCodeDir);
  await writeFile(path.join(openChamberDir, 'preferences.json'), JSON.stringify({
    version: 1,
    fields: {
      darkThemeId: 'private-theme-name',
      favoriteModels: ['provider/model'],
      activeProjectId: '/local/project',
    },
  }));
  await writeFile(path.join(openChamberDir, 'extensions.json'), JSON.stringify({
    gitOrigins: { '/local/extension': { url: 'https://github.com/acme/extension' } },
    capabilityGrants: { extension: ['service'] },
  }));
  await writeFile(path.join(openCodeDir, 'opencode.json'), JSON.stringify({
    model: 'provider/model',
    provider: { apiKey: 'must-not-leak', options: { timeout: 1000 } },
  }));

  try {
    const preview = await createLocalPreview({ openChamberDir, openCodeDir });

    assert.deepEqual(preview.sources, [
      { id: 'preferences', status: 'ready', portableItems: 2 },
      { id: 'opencode', status: 'ready', portableItems: 2 },
      { id: 'extensions', status: 'ready', portableItems: 1 },
    ]);
    assert.doesNotMatch(JSON.stringify(preview), /private-theme-name|local\/project|must-not-leak/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fails closed on symlinked or malformed config files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openchamber-sync-'));
  const openChamberDir = path.join(root, 'openchamber');
  const openCodeDir = path.join(root, 'opencode');
  await mkdir(openChamberDir);
  await mkdir(openCodeDir);
  await writeFile(path.join(root, 'outside.json'), JSON.stringify({ version: 1, fields: {} }));
  await symlink(path.join(root, 'outside.json'), path.join(openChamberDir, 'preferences.json'));
  await writeFile(path.join(openCodeDir, 'opencode.json'), '{broken');

  try {
    const preview = await createLocalPreview({ openChamberDir, openCodeDir });
    assert.deepEqual(preview.sources, [
      { id: 'preferences', status: 'unavailable', portableItems: 0 },
      { id: 'opencode', status: 'unavailable', portableItems: 0 },
      { id: 'extensions', status: 'missing', portableItems: 0 },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
