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
