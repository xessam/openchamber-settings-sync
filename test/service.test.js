import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createMachineState } from '../src/state.js';
import { createServiceServer } from '../src/service.js';

async function startServer(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test('requires the service bearer token and previews only safe summary data', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openchamber-sync-'));
  const openChamberDir = path.join(root, 'openchamber');
  const openCodeDir = path.join(root, 'opencode');
  await mkdir(openChamberDir);
  await mkdir(openCodeDir);
  await writeFile(path.join(openChamberDir, 'preferences.json'), JSON.stringify({
    version: 1,
    fields: { darkThemeId: 'private-theme-name' },
  }));
  await writeFile(path.join(openCodeDir, 'opencode.json'), JSON.stringify({
    provider: { apiKey: 'must-not-leak' },
  }));
  const server = createServiceServer({ token: 'test-service-token', openChamberDir, openCodeDir });

  try {
    const origin = await startServer(server);
    const unauthorized = await fetch(`${origin}/health`);
    assert.equal(unauthorized.status, 401);

    const health = await fetch(`${origin}/health`, {
      headers: { authorization: 'Bearer test-service-token' },
    });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const previewResponse = await fetch(`${origin}/preview`, {
      headers: { authorization: 'Bearer test-service-token' },
    });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.deepEqual(preview.sources, [
      { id: 'preferences', status: 'ready', portableItems: 1 },
      { id: 'opencode', status: 'ready', portableItems: 1 },
      { id: 'opencode-files', status: 'ready', portableItems: 0 },
      { id: 'extensions', status: 'missing', portableItems: 0 },
    ]);
    assert.doesNotMatch(JSON.stringify(preview), /private-theme-name|must-not-leak/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('previews local and remote changes per file without writing configuration', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openchamber-sync-'));
  const openChamberDir = path.join(root, 'openchamber');
  const openCodeDir = path.join(root, 'opencode');
  const agentDir = path.join(openCodeDir, 'agents');
  await mkdir(openChamberDir);
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(openChamberDir, 'preferences.json'), JSON.stringify({
    version: 1,
    fields: { darkThemeId: 'local-theme' },
  }));
  await writeFile(path.join(openChamberDir, 'extensions.json'), JSON.stringify({ gitOrigins: {} }));
  await writeFile(path.join(openCodeDir, 'opencode.json'), JSON.stringify({ model: 'provider/local' }));
  const localAgent = path.join(agentDir, 'review.md');
  await writeFile(localAgent, 'Local review instructions.');
  const remoteState = createMachineState({
    machineId: 'other-machine',
    values: {
      'preferences.darkThemeId': 'remote-theme',
      'extensions.repositories': [],
      'opencode.kbW9kZWw': 'provider/local',
      [`opencodeFile.k${Buffer.from('agents/review.md').toString('base64url')}`]: 'Remote review instructions.',
    },
    now: 123,
  });
  let requestedUrl;
  const server = createServiceServer({
    token: 'test-service-token',
    openChamberDir,
    openCodeDir,
    stateReader: async (url) => {
      requestedUrl = url;
      return { empty: false, states: [remoteState] };
    },
  });
  try {
    const origin = await startServer(server);
    const response = await fetch(`${origin}/repository/preview`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-service-token', 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'git@github.com:acme/config.git', machineId: 'local-machine' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(requestedUrl, 'git@github.com:acme/config.git');
    assert.equal(body.empty, false);
    assert.equal(body.remoteMachineCount, 1);
    assert.equal(body.machineIdentityReady, true);
    assert.equal(body.machineRegistered, false);
    assert.deepEqual(body.comparison.items.map(({ path: itemPath, action }) => [itemPath, action]), [
      ['OpenChamber preferences · darkThemeId', 'conflict'],
      ['OpenCode agents/review.md', 'conflict'],
    ]);
    assert.equal(body.comparison.canConfirm, true);
    assert.equal(body.comparison.items[1].local.preview, 'Local review instructions.');
    assert.equal(body.comparison.items[1].remote.preview, 'Remote review instructions.');
    assert.equal(await readFile(localAgent, 'utf8'), 'Local review instructions.');
    assert.doesNotMatch(JSON.stringify(body), /other-machine|local-machine/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('does not allow first-sync confirmation when device-scoped identity is unavailable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openchamber-sync-'));
  const openChamberDir = path.join(root, 'openchamber');
  const openCodeDir = path.join(root, 'opencode');
  await mkdir(openChamberDir);
  await mkdir(openCodeDir);
  await writeFile(path.join(openChamberDir, 'preferences.json'), JSON.stringify({ version: 1, fields: {} }));
  await writeFile(path.join(openChamberDir, 'extensions.json'), JSON.stringify({ gitOrigins: {} }));
  await writeFile(path.join(openCodeDir, 'opencode.json'), JSON.stringify({ model: 'provider/local' }));
  const server = createServiceServer({
    token: 'test-service-token',
    openChamberDir,
    openCodeDir,
    stateReader: async () => ({ empty: true, states: [] }),
  });
  try {
    const origin = await startServer(server);
    const response = await fetch(`${origin}/repository/preview`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-service-token', 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/acme/config.git' }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.machineIdentityReady, false);
    assert.equal(body.comparison.canConfirm, false);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('maps remote-state failures to safe public errors', async () => {
  const server = createServiceServer({
    token: 'test-service-token',
    openChamberDir: '/unused',
    openCodeDir: '/unused',
    stateReader: async () => {
      throw Object.assign(new Error('private remote content'), { code: 'REMOTE_STATE_INVALID' });
    },
  });
  try {
    const origin = await startServer(server);
    const response = await fetch(`${origin}/repository/preview`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-service-token', 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/acme/config.git' }),
    });
    assert.equal(response.status, 422);
    const body = await response.text();
    assert.deepEqual(JSON.parse(body), { error: 'remote-state-invalid' });
    assert.doesNotMatch(body, /private remote content/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('requires explicit confirmation for every conflict and binds it to the unchanged preview', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openchamber-sync-'));
  const openChamberDir = path.join(root, 'openchamber');
  const openCodeDir = path.join(root, 'opencode');
  await mkdir(openChamberDir);
  await mkdir(openCodeDir);
  await writeFile(path.join(openChamberDir, 'preferences.json'), JSON.stringify({
    version: 1,
    fields: { darkThemeId: 'local-theme' },
  }));
  await writeFile(path.join(openChamberDir, 'extensions.json'), JSON.stringify({ gitOrigins: {} }));
  await writeFile(path.join(openCodeDir, 'opencode.json'), JSON.stringify({ model: 'provider/local' }));
  const state = createMachineState({ machineId: 'remote', values: { 'preferences.darkThemeId': 'remote-theme' }, now: 100 });
  const machineId = 'local-machine';
  const server = createServiceServer({
    token: 'test-service-token',
    openChamberDir,
    openCodeDir,
    stateReader: async () => ({ empty: false, states: [state] }),
  });
  try {
    const origin = await startServer(server);
    const previewResponse = await fetch(`${origin}/repository/preview`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-service-token', 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/acme/config.git', machineId }),
    });
    const preview = await previewResponse.json();
    assert.equal(previewResponse.status, 200);
    assert.equal(preview.comparison.conflicts, 1);

    const missingChoice = await fetch(`${origin}/repository/confirm`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-service-token', 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/acme/config.git', machineId, previewId: preview.previewId, resolutions: '', confirmed: true }),
    });
    assert.equal(missingChoice.status, 422);
    assert.deepEqual(await missingChoice.json(), { error: 'preview-not-confirmable' });

    const confirmation = await fetch(`${origin}/repository/confirm`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-service-token', 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/acme/config.git', machineId, previewId: preview.previewId, resolutions: 'L', confirmed: true }),
    });
    assert.equal(confirmation.status, 200);
    assert.deepEqual(await confirmation.json(), { confirmed: true, changesMade: false });
    assert.equal(JSON.parse(await readFile(path.join(openChamberDir, 'preferences.json'), 'utf8')).fields.darkThemeId, 'local-theme');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects confirmation when local configuration changed after the preview', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openchamber-sync-'));
  const openChamberDir = path.join(root, 'openchamber');
  const openCodeDir = path.join(root, 'opencode');
  await mkdir(openChamberDir);
  await mkdir(openCodeDir);
  const preferencesPath = path.join(openChamberDir, 'preferences.json');
  const machineId = 'local-machine';
  await writeFile(preferencesPath, JSON.stringify({ version: 1, fields: { darkThemeId: 'before' } }));
  await writeFile(path.join(openChamberDir, 'extensions.json'), JSON.stringify({ gitOrigins: {} }));
  await writeFile(path.join(openCodeDir, 'opencode.json'), JSON.stringify({ model: 'provider/local' }));
  const server = createServiceServer({
    token: 'test-service-token',
    openChamberDir,
    openCodeDir,
    stateReader: async () => ({ empty: true, states: [] }),
  });
  try {
    const origin = await startServer(server);
    const previewResponse = await fetch(`${origin}/repository/preview`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-service-token', 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/acme/config.git', machineId }),
    });
    const preview = await previewResponse.json();
    await writeFile(preferencesPath, JSON.stringify({ version: 1, fields: { darkThemeId: 'after' } }));
    const confirmation = await fetch(`${origin}/repository/confirm`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-service-token', 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/acme/config.git', machineId, previewId: preview.previewId, resolutions: '', confirmed: true }),
    });
    assert.equal(confirmation.status, 409);
    assert.deepEqual(await confirmation.json(), { error: 'preview-stale' });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('prepares an initial machine state only after confirmed review of an empty repository', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openchamber-sync-'));
  const openChamberDir = path.join(root, 'openchamber');
  const openCodeDir = path.join(root, 'opencode');
  const machineId = '550e8400-e29b-41d4-a716-446655440000';
  await mkdir(openChamberDir);
  await mkdir(openCodeDir);
  await writeFile(path.join(openChamberDir, 'preferences.json'), JSON.stringify({
    version: 1,
    fields: { darkThemeId: 'local-theme' },
  }));
  await writeFile(path.join(openChamberDir, 'extensions.json'), JSON.stringify({ gitOrigins: {} }));
  await writeFile(path.join(openCodeDir, 'opencode.json'), JSON.stringify({ model: 'provider/local' }));
  const server = createServiceServer({
    token: 'test-service-token',
    openChamberDir,
    openCodeDir,
    stateReader: async () => ({ empty: true, states: [] }),
  });
  try {
    const origin = await startServer(server);
    const previewResponse = await fetch(`${origin}/repository/preview`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-service-token', 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/acme/config.git', machineId }),
    });
    const preview = await previewResponse.json();
    assert.equal(previewResponse.status, 200);
    assert.equal(preview.machineIdentityReady, true);
    assert.equal(preview.comparison.canConfirm, true);

    const confirmation = await fetch(`${origin}/repository/confirm`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-service-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        url: 'https://github.com/acme/config.git',
        machineId,
        previewId: preview.previewId,
        resolutions: '',
        confirmed: true,
      }),
    });
    assert.equal(confirmation.status, 200);
    assert.deepEqual(await confirmation.json(), {
      confirmed: true,
      changesMade: false,
      bootstrap: {
        branch: 'main',
        path: `machines/${machineId}/state.json`,
        entryCount: 3,
      },
    });
    assert.equal(JSON.parse(await readFile(path.join(openChamberDir, 'preferences.json'), 'utf8')).fields.darkThemeId, 'local-theme');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('tests a repository URL through the read-only Git probe', async () => {
  let probedUrl;
  const server = createServiceServer({
    token: 'test-service-token',
    openChamberDir: '/unused',
    openCodeDir: '/unused',
    gitProbe: async (url) => {
      probedUrl = url;
      return { repository: 'acme/config', url };
    },
  });

  try {
    const origin = await startServer(server);
    const response = await fetch(`${origin}/repository/test`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-service-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ url: 'https://github.com/acme/config.git' }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      accessible: true,
      repository: 'acme/config',
      url: 'https://github.com/acme/config.git',
    });
    assert.equal(probedUrl, 'https://github.com/acme/config.git');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('rejects credential-bearing repository URLs without echoing them', async () => {
  const server = createServiceServer({
    token: 'test-service-token',
    openChamberDir: '/unused',
    openCodeDir: '/unused',
  });

  try {
    const origin = await startServer(server);
    const response = await fetch(`${origin}/repository/test`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-service-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ url: 'https://alice:secret@github.com/acme/config.git' }),
    });

    assert.equal(response.status, 400);
    const body = await response.text();
    assert.equal(body, '{"error":"invalid-repository-url"}');
    assert.doesNotMatch(body, /alice|secret/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('returns only allowlisted diagnostic fields for a failed SSH probe', async () => {
  const server = createServiceServer({
    token: 'test-service-token',
    gitProbe: async () => {
      throw Object.assign(new Error('secret-token'), {
        code: 'GIT_ACCESS_FAILED',
        diagnostics: { transport: 'ssh', reason: 'ssh-authentication', sshAgent: 'not-configured', exitCode: 128, stderr: 'secret-token' },
      });
    },
  });
  try {
    const origin = await startServer(server);
    const response = await fetch(`${origin}/repository/test`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-service-token', 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'git@github.com:acme/config.git' }),
    });
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.deepEqual(body, { error: 'git-access-failed', diagnostics: {
      transport: 'ssh', reason: 'ssh-authentication', sshAgent: 'not-configured', exitCode: 128,
    } });
    assert.doesNotMatch(JSON.stringify(body), /secret-token/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('does not return Git stderr from a failed private-repo check', async () => {
  const server = createServiceServer({
    token: 'test-service-token',
    openChamberDir: '/unused',
    openCodeDir: '/unused',
    gitProbe: async () => {
      throw Object.assign(new Error('credential helper private output'), { code: 'GIT_ACCESS_FAILED' });
    },
  });

  try {
    const origin = await startServer(server);
    const response = await fetch(`${origin}/repository/test`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-service-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ url: 'https://github.com/acme/config.git' }),
    });

    assert.equal(response.status, 422);
    const body = await response.text();
    assert.equal(body, '{"error":"git-access-failed"}');
    assert.doesNotMatch(body, /credential helper|private output/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

const bootstrapMachineId = '550e8400-e29b-41d4-a716-446655440000';

async function bootstrapFixtureServer({ openChamberDir, openCodeDir, stateReader, repositoryPusher }) {
  const server = createServiceServer({
    token: 'test-service-token',
    openChamberDir,
    openCodeDir,
    stateReader,
    repositoryPusher,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function readBootstrapPreview(origin, url = 'https://github.com/acme/config.git') {
  const response = await fetch(`${origin}/repository/preview`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-service-token', 'content-type': 'application/json' },
    body: JSON.stringify({ url, machineId: bootstrapMachineId }),
  });
  const preview = await response.json();
  assert.equal(response.status, 200);
  return preview;
}

function bootstrapRequest(origin, preview, overrides = {}) {
  return fetch(`${origin}/repository/bootstrap`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-service-token', 'content-type': 'application/json' },
    body: JSON.stringify({
      url: 'https://github.com/acme/config.git',
      machineId: bootstrapMachineId,
      previewId: preview.previewId,
      resolutions: '',
      confirmed: true,
      ...overrides,
    }),
  });
}

test('pushes the confirmed initial state after revalidating the preview in the same operation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openchamber-sync-'));
  const openChamberDir = path.join(root, 'openchamber');
  const openCodeDir = path.join(root, 'opencode');
  await mkdir(openChamberDir);
  await mkdir(openCodeDir);
  await writeFile(path.join(openChamberDir, 'preferences.json'), JSON.stringify({
    version: 1,
    fields: { darkThemeId: 'local-theme' },
  }));
  await writeFile(path.join(openChamberDir, 'extensions.json'), JSON.stringify({ gitOrigins: {} }));
  await writeFile(path.join(openCodeDir, 'opencode.json'), JSON.stringify({ model: 'provider/local' }));
  const pushes = [];
  const { origin, close } = await bootstrapFixtureServer({
    openChamberDir,
    openCodeDir,
    stateReader: async () => ({ empty: true, states: [] }),
    repositoryPusher: async (request) => {
      pushes.push(request);
      return { commit: 'c'.repeat(40), branch: 'main' };
    },
  });
  try {
    const preview = await readBootstrapPreview(origin);
    const response = await bootstrapRequest(origin, preview);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, {
      confirmed: true,
      changesMade: true,
      bootstrap: {
        branch: 'main',
        path: `machines/${bootstrapMachineId}/state.json`,
        entryCount: 3,
      },
      commit: 'c'.repeat(40),
    });
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].url, 'https://github.com/acme/config.git');
    assert.equal(pushes[0].branch, 'main');
    assert.equal(pushes[0].path, `machines/${bootstrapMachineId}/state.json`);
    assert.equal(typeof pushes[0].commitTimestamp, 'number');
    const pushedState = JSON.parse(pushes[0].content);
    assert.equal(pushedState.machineId, bootstrapMachineId);
    assert.equal(pushedState.entries['preferences.darkThemeId'].value, 'local-theme');
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses to push when local configuration changed after the preview', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openchamber-sync-'));
  const openChamberDir = path.join(root, 'openchamber');
  const openCodeDir = path.join(root, 'opencode');
  const preferencesPath = path.join(openChamberDir, 'preferences.json');
  await mkdir(openChamberDir);
  await mkdir(openCodeDir);
  await writeFile(preferencesPath, JSON.stringify({ version: 1, fields: { darkThemeId: 'before' } }));
  await writeFile(path.join(openChamberDir, 'extensions.json'), JSON.stringify({ gitOrigins: {} }));
  await writeFile(path.join(openCodeDir, 'opencode.json'), JSON.stringify({ model: 'provider/local' }));
  const pushes = [];
  const { origin, close } = await bootstrapFixtureServer({
    openChamberDir,
    openCodeDir,
    stateReader: async () => ({ empty: true, states: [] }),
    repositoryPusher: async (request) => {
      pushes.push(request);
      return { commit: 'c'.repeat(40), branch: 'main' };
    },
  });
  try {
    const preview = await readBootstrapPreview(origin);
    await writeFile(preferencesPath, JSON.stringify({ version: 1, fields: { darkThemeId: 'after' } }));
    const response = await bootstrapRequest(origin, preview);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'preview-stale' });
    assert.equal(pushes.length, 0);
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

test('applies the same confirmation rules to bootstrap and refuses an invalid body', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openchamber-sync-'));
  const openChamberDir = path.join(root, 'openchamber');
  const openCodeDir = path.join(root, 'opencode');
  await mkdir(openChamberDir);
  await mkdir(openCodeDir);
  await writeFile(path.join(openChamberDir, 'preferences.json'), JSON.stringify({
    version: 1,
    fields: { darkThemeId: 'local-theme' },
  }));
  await writeFile(path.join(openChamberDir, 'extensions.json'), JSON.stringify({ gitOrigins: {} }));
  await writeFile(path.join(openCodeDir, 'opencode.json'), JSON.stringify({ model: 'provider/local' }));
  const pushes = [];
  const { origin, close } = await bootstrapFixtureServer({
    openChamberDir,
    openCodeDir,
    stateReader: async () => ({ empty: true, states: [] }),
    repositoryPusher: async (request) => {
      pushes.push(request);
      return { commit: 'c'.repeat(40), branch: 'main' };
    },
  });
  try {
    const preview = await readBootstrapPreview(origin);
    const unresolved = await bootstrapRequest(origin, preview, { resolutions: 'L' });
    assert.equal(unresolved.status, 422);
    assert.deepEqual(await unresolved.json(), { error: 'preview-not-confirmable' });

    const unconfirmed = await bootstrapRequest(origin, preview, { confirmed: false });
    assert.equal(unconfirmed.status, 400);

    const invalidMachine = await bootstrapRequest(origin, preview, { machineId: '../bad' });
    assert.equal(invalidMachine.status, 400);
    assert.equal(pushes.length, 0);
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses to bootstrap a repository that already contains machine states', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openchamber-sync-'));
  const openChamberDir = path.join(root, 'openchamber');
  const openCodeDir = path.join(root, 'opencode');
  await mkdir(openChamberDir);
  await mkdir(openCodeDir);
  await writeFile(path.join(openChamberDir, 'preferences.json'), JSON.stringify({
    version: 1,
    fields: { darkThemeId: 'local-theme' },
  }));
  await writeFile(path.join(openChamberDir, 'extensions.json'), JSON.stringify({ gitOrigins: {} }));
  await writeFile(path.join(openCodeDir, 'opencode.json'), JSON.stringify({ model: 'provider/local' }));
  const remoteState = createMachineState({
    machineId: 'other-machine',
    values: { 'preferences.darkThemeId': 'local-theme', 'extensions.repositories': [], 'opencode.kbW9kZWw': 'provider/local' },
    now: 100,
  });
  const pushes = [];
  const { origin, close } = await bootstrapFixtureServer({
    openChamberDir,
    openCodeDir,
    stateReader: async () => ({ empty: false, states: [remoteState] }),
    repositoryPusher: async (request) => {
      pushes.push(request);
      return { commit: 'c'.repeat(40), branch: 'main' };
    },
  });
  try {
    const preview = await readBootstrapPreview(origin);
    const response = await bootstrapRequest(origin, preview);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'repository-changed' });
    assert.equal(pushes.length, 0);
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

test('maps bootstrap push failures to safe public errors', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openchamber-sync-'));
  const openChamberDir = path.join(root, 'openchamber');
  const openCodeDir = path.join(root, 'opencode');
  await mkdir(openChamberDir);
  await mkdir(openCodeDir);
  await writeFile(path.join(openChamberDir, 'preferences.json'), JSON.stringify({
    version: 1,
    fields: { darkThemeId: 'local-theme' },
  }));
  await writeFile(path.join(openChamberDir, 'extensions.json'), JSON.stringify({ gitOrigins: {} }));
  await writeFile(path.join(openCodeDir, 'opencode.json'), JSON.stringify({ model: 'provider/local' }));
  let failure;
  const { origin, close } = await bootstrapFixtureServer({
    openChamberDir,
    openCodeDir,
    stateReader: async () => ({ empty: true, states: [] }),
    repositoryPusher: async () => {
      throw Object.assign(new Error('credential helper private output'), { code: failure });
    },
  });
  try {
    const preview = await readBootstrapPreview(origin);
    for (const { code, status, error } of [
      { code: 'REPOSITORY_CHANGED', status: 409, error: 'repository-changed' },
      { code: 'GIT_PUSH_FAILED', status: 422, error: 'git-push-failed' },
      { code: 'GIT_TIMEOUT', status: 504, error: 'git-timeout' },
    ]) {
      failure = code;
      const response = await bootstrapRequest(origin, preview);
      assert.equal(response.status, status);
      const body = await response.text();
      assert.equal(body, `{"error":"${error}"}`);
      assert.doesNotMatch(body, /credential helper|private output/);
    }
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});
