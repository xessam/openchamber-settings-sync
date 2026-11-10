import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
      { id: 'extensions', status: 'missing', portableItems: 0 },
    ]);
    assert.doesNotMatch(JSON.stringify(preview), /private-theme-name|must-not-leak/);
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
