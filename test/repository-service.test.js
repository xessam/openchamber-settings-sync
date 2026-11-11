import test from 'node:test';
import assert from 'node:assert/strict';
import { OPENCHAMBER_SDK_API_VERSION, OPENCHAMBER_SDK_CHANNEL } from '@openchamber/sdk';
import { guestMessageSchema } from '@openchamber/sdk/schemas';

import { runFirstSyncConfirmation, runFirstSyncPreview, runRepositoryBootstrap, runRepositoryProbe } from '../src/repository-service.js';

test('warms the local service before testing the remote and reports the stage', async () => {
  const calls = [];
  const result = await runRepositoryProbe(async (request) => {
    calls.push(request);
    return request.path === '/health'
      ? { status: 200, body: '{"ok":true}' }
      : { status: 200, body: '{"accessible":true}' };
  }, 'git@github.com:owner/repo.git', () => calls.push('ready'));

  assert.deepEqual(calls.map((call) => typeof call === 'string' ? call : `${call.method} ${call.path}`), [
    'GET /health',
    'ready',
    'POST /repository/test',
  ]);
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(calls[2].body), { url: 'git@github.com:owner/repo.git' });
  assert.equal(guestMessageSchema.safeParse({
    channel: OPENCHAMBER_SDK_CHANNEL,
    v: OPENCHAMBER_SDK_API_VERSION,
    type: 'service-request',
    id: 'test-request',
    payload: calls[2],
  }).success, true);
});

test('does not attempt Git when the service health check is not ready', async () => {
  const calls = [];
  await assert.rejects(
    runRepositoryProbe(async (request) => {
      calls.push(request.path);
      return { status: 503, body: '{"error":"unavailable"}' };
    }, 'git@github.com:owner/repo.git'),
    (error) => error.code === 'SERVICE_NOT_READY',
  );
  assert.deepEqual(calls, ['/health']);
});

test('warms the service before requesting a read-only first-sync preview', async () => {
  const calls = [];
  const response = await runFirstSyncPreview(async (request) => {
    calls.push(request);
    return request.path === '/health'
      ? { status: 200 }
      : { status: 200, body: '{"empty":true}' };
  }, 'https://github.com/acme/config.git', { machineId: 'local-machine' });
  assert.deepEqual(calls.map(({ method, path }) => `${method} ${path}`), [
    'GET /health',
    'POST /repository/preview',
  ]);
  assert.deepEqual(JSON.parse(calls[1].body), { url: 'https://github.com/acme/config.git', machineId: 'local-machine' });
  assert.equal(response.status, 200);
});

test('sends the explicit first-sync confirmation and conflict resolutions', async () => {
  const calls = [];
  const response = await runFirstSyncConfirmation(async (request) => {
    calls.push(request);
    return request.path === '/health' ? { status: 200 } : { status: 200, body: '{"confirmed":true}' };
  }, {
    url: 'git@github.com:acme/config.git',
    machineId: 'local-machine',
    previewId: 'a'.repeat(64),
    resolutions: 'LR',
    confirmed: true,
  });
  assert.deepEqual(calls.map(({ method, path }) => `${method} ${path}`), [
    'GET /health',
    'POST /repository/confirm',
  ]);
  assert.deepEqual(JSON.parse(calls[1].body), {
    url: 'git@github.com:acme/config.git',
    machineId: 'local-machine',
    previewId: 'a'.repeat(64),
    resolutions: 'LR',
    confirmed: true,
  });
  assert.equal(response.status, 200);
});

test('sends the bootstrap push as its own revalidated service request', async () => {
  const calls = [];
  const response = await runRepositoryBootstrap(async (request) => {
    calls.push(request);
    return request.path === '/health' ? { status: 200 } : { status: 200, body: '{"confirmed":true,"changesMade":true}' };
  }, {
    url: 'git@github.com:acme/config.git',
    machineId: 'local-machine',
    previewId: 'a'.repeat(64),
    resolutions: '',
    confirmed: true,
  }, () => calls.push('ready'));
  assert.deepEqual(calls.map((call) => typeof call === 'string' ? call : `${call.method} ${call.path}`), [
    'GET /health',
    'ready',
    'POST /repository/bootstrap',
  ]);
  assert.deepEqual(JSON.parse(calls[2].body), {
    url: 'git@github.com:acme/config.git',
    machineId: 'local-machine',
    previewId: 'a'.repeat(64),
    resolutions: '',
    confirmed: true,
  });
  assert.equal(response.status, 200);
});
