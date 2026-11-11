import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { createServiceServer } from '../src/service.js';
import { createMachineState } from '../src/state.js';
import { defaultApplyJournalPath } from '../src/local-apply.js';

async function startServer(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

function fileKey(relativePath) {
  return `opencodeFile.k${Buffer.from(relativePath, 'utf8').toString('base64url')}`;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function writeLocalConfig(root) {
  const openChamberDir = path.join(root, 'openchamber');
  const openCodeDir = path.join(root, 'opencode');
  await mkdir(path.join(openChamberDir), { recursive: true });
  await mkdir(path.join(openCodeDir, 'agents'), { recursive: true });
  await writeFile(path.join(openChamberDir, 'preferences.json'), JSON.stringify({
    version: 1,
    fields: { darkThemeId: 'local-theme' },
  }));
  await writeFile(path.join(openChamberDir, 'extensions.json'), JSON.stringify({ gitOrigins: {} }));
  await writeFile(path.join(openCodeDir, 'opencode.json'), JSON.stringify({ model: 'provider/local' }));
  await writeFile(path.join(openCodeDir, 'agents', 'review.md'), 'Local review instructions.');
  return { openChamberDir, openCodeDir };
}

function remoteState() {
  return createMachineState({
    machineId: 'other-machine',
    values: {
      'preferences.darkThemeId': 'remote-theme',
      'extensions.repositories': ['https://github.com/acme/ext.git'],
      'opencode.kbW9kZWw': 'provider/remote',
      [fileKey('agents/review.md')]: 'Remote review instructions.',
    },
    now: 123,
  });
}

async function requestPreview(origin, body) {
  const response = await fetch(`${origin}/repository/preview`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-service-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('applies only the approved changes to local files after revalidation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openchamber-apply-service-'));
  try {
    const { openChamberDir, openCodeDir } = await writeLocalConfig(root);
    const server = createServiceServer({
      token: 'test-service-token',
      openChamberDir,
      openCodeDir,
      stateReader: async () => ({ empty: false, states: [remoteState()] }),
    });
    const origin = await startServer(server);
    try {
      const preview = await requestPreview(origin, { url: 'https://github.com/acme/config.git', machineId: 'local-machine' });
      assert.equal(preview.status, 200);
      assert.equal(preview.body.comparison.conflicts, 4);

      const wrongResolutions = await fetch(`${origin}/repository/apply`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-service-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          url: 'https://github.com/acme/config.git',
          machineId: 'local-machine',
          previewId: preview.body.previewId,
          resolutions: '',
          confirmed: true,
        }),
      });
      assert.equal(wrongResolutions.status, 422);
      assert.deepEqual(await wrongResolutions.json(), { error: 'preview-not-confirmable' });

      const apply = await fetch(`${origin}/repository/apply`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-service-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          url: 'https://github.com/acme/config.git',
          machineId: 'local-machine',
          previewId: preview.body.previewId,
          resolutions: 'RRRR',
          confirmed: true,
        }),
      });
      assert.equal(apply.status, 200);
      const applied = await apply.json();
      assert.equal(applied.confirmed, true);
      assert.equal(applied.changesMade, true);
      assert.equal(applied.recovered, false);
      assert.equal(applied.applied, 4);

      assert.equal(JSON.parse(await readFile(path.join(openChamberDir, 'preferences.json'), 'utf8')).fields.darkThemeId, 'remote-theme');
      assert.equal(JSON.parse(await readFile(path.join(openCodeDir, 'opencode.json'), 'utf8')).model, 'provider/remote');
      const extensions = JSON.parse(await readFile(path.join(openChamberDir, 'extensions.json'), 'utf8'));
      assert.deepEqual(Object.values(extensions.gitOrigins).map((origin) => origin.url), ['https://github.com/acme/ext.git']);
      assert.equal(await readFile(path.join(openCodeDir, 'agents', 'review.md'), 'utf8'), 'Remote review instructions.');
      assert.equal(await readdir(openChamberDir).then((entries) => entries.includes('.openchamber-sync-apply-journal.json')), false);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses to apply when the preview is stale or the repository is empty', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openchamber-apply-service-'));
  try {
    const { openChamberDir, openCodeDir } = await writeLocalConfig(root);
    const preferencesPath = path.join(openChamberDir, 'preferences.json');
    let state = { empty: false, states: [remoteState()] };
    const server = createServiceServer({
      token: 'test-service-token',
      openChamberDir,
      openCodeDir,
      stateReader: async () => state,
    });
    const origin = await startServer(server);
    try {
      const preview = await requestPreview(origin, { url: 'https://github.com/acme/config.git', machineId: 'local-machine' });
      assert.equal(preview.status, 200);

      await writeFile(preferencesPath, JSON.stringify({ version: 1, fields: { darkThemeId: 'changed-locally' } }));
      const stale = await fetch(`${origin}/repository/apply`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-service-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          url: 'https://github.com/acme/config.git',
          machineId: 'local-machine',
          previewId: preview.body.previewId,
          resolutions: 'RRRR',
          confirmed: true,
        }),
      });
      assert.equal(stale.status, 409);
      assert.deepEqual(await stale.json(), { error: 'preview-stale' });

      await writeFile(preferencesPath, JSON.stringify({ version: 1, fields: { darkThemeId: 'local-theme' } }));
      state = { empty: true, states: [] };
      const emptyPreview = await requestPreview(origin, { url: 'https://github.com/acme/config.git', machineId: 'local-machine' });
      assert.equal(emptyPreview.status, 200);
      const emptyRepository = await fetch(`${origin}/repository/apply`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-service-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          url: 'https://github.com/acme/config.git',
          machineId: 'local-machine',
          previewId: emptyPreview.body.previewId,
          resolutions: '',
          confirmed: true,
        }),
      });
      assert.equal(emptyRepository.status, 422);
      assert.deepEqual(await emptyRepository.json(), { error: 'nothing-to-apply' });
      assert.equal(JSON.parse(await readFile(preferencesPath, 'utf8')).fields.darkThemeId, 'local-theme');
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rolls back an interrupted apply before applying a fresh plan', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openchamber-apply-service-'));
  try {
    const { openChamberDir, openCodeDir } = await writeLocalConfig(root);
    const preferencesPath = path.join(openChamberDir, 'preferences.json');
    // Simulate a half-finished apply: the new value was written, the backup
    // and marker remain.
    const appliedText = `${JSON.stringify({ version: 1, fields: { darkThemeId: 'half-applied' } }, null, 2)}\n`;
    await writeFile(preferencesPath, appliedText);
    const backupPath = `${preferencesPath}.sync-backup-${sha256('leftover').slice(0, 16)}`;
    await writeFile(backupPath, `${JSON.stringify({ version: 1, fields: { darkThemeId: 'local-theme' } }, null, 2)}\n`);
    await writeFile(defaultApplyJournalPath(openChamberDir), `${JSON.stringify({
      version: 1,
      planId: sha256('interrupted'),
      steps: [{
        id: 0,
        target: preferencesPath,
        kind: 'settings',
        type: 'write',
        temp: null,
        backup: backupPath,
        created: false,
        createdDirs: [],
        resultHash: sha256(appliedText),
        status: 'done',
      }],
    }, null, 2)}\n`);

    const server = createServiceServer({
      token: 'test-service-token',
      openChamberDir,
      openCodeDir,
      stateReader: async () => ({ empty: false, states: [remoteState()] }),
    });
    const origin = await startServer(server);
    try {
      const preview = await requestPreview(origin, { url: 'https://github.com/acme/config.git', machineId: 'local-machine' });
      assert.equal(preview.status, 200);
      const apply = await fetch(`${origin}/repository/apply`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-service-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          url: 'https://github.com/acme/config.git',
          machineId: 'local-machine',
          previewId: preview.body.previewId,
          resolutions: 'RRRR',
          confirmed: true,
        }),
      });
      assert.equal(apply.status, 200);
      const applied = await apply.json();
      assert.equal(applied.recovered, true);
      assert.equal(JSON.parse(await readFile(preferencesPath, 'utf8')).fields.darkThemeId, 'remote-theme');
      assert.equal(await readdir(openChamberDir).then((entries) => entries.includes('.openchamber-sync-apply-journal.json')), false);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('requires authentication and a well-formed apply request', async () => {
  const server = createServiceServer({
    token: 'test-service-token',
    openChamberDir: '/unused',
    openCodeDir: '/unused',
  });
  const origin = await startServer(server);
  try {
    const unauthorized = await fetch(`${origin}/repository/apply`, { method: 'POST' });
    assert.equal(unauthorized.status, 401);

    const malformed = await fetch(`${origin}/repository/apply`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-service-token', 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/acme/config.git' }),
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: 'invalid-request' });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
