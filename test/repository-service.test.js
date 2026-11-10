import test from 'node:test';
import assert from 'node:assert/strict';

import { runRepositoryProbe } from '../src/repository-service.js';

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
  assert.deepEqual(calls[2].body, { url: 'git@github.com:owner/repo.git' });
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
