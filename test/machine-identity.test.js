import test from 'node:test';
import assert from 'node:assert/strict';

import { getOrCreateMachineId } from '../src/machine-identity.js';

const identity = '550e8400-e29b-41d4-a716-446655440000';

function withLock(callback) {
  return { request: (_name, options, operation) => {
    assert.deepEqual(options, { mode: 'exclusive' });
    return operation({ name: 'identity-lock' });
  } };
}

test('reuses a valid identity from device-scoped storage', async () => {
  const calls = [];
  const machineId = await getOrCreateMachineId({
    deviceStorageAvailable: true,
    lockManager: withLock(),
    storage: {
      async get(key, options) { calls.push(['get', key, options]); return identity; },
      async set() { assert.fail('a valid identity must not be rewritten'); },
    },
    randomUUID() { assert.fail('a valid identity must not be regenerated'); },
  });
  assert.equal(machineId, identity);
  assert.deepEqual(calls, [['get', 'machineId', { scope: 'device' }]]);
});

test('creates, persists, and reads back a device identity', async () => {
  let stored;
  let generated = 0;
  const machineId = await getOrCreateMachineId({
    deviceStorageAvailable: true,
    lockManager: withLock(),
    storage: {
      async get(_key, options) { assert.deepEqual(options, { scope: 'device' }); return stored; },
      async set(key, value, options) {
        assert.equal(key, 'machineId');
        assert.deepEqual(options, { scope: 'device' });
        stored = value;
      },
    },
    randomUUID() { generated += 1; return identity; },
  });
  assert.equal(machineId, identity);
  assert.equal(stored, identity);
  assert.equal(generated, 1);
});

test('refuses unsupported device storage or missing cross-tab locking without falling back', async () => {
  let storageCalls = 0;
  const options = {
    deviceStorageAvailable: true,
    storage: {
      async get() { storageCalls += 1; return undefined; },
      async set() { storageCalls += 1; },
    },
    randomUUID: () => identity,
  };
  await assert.rejects(getOrCreateMachineId({ ...options, deviceStorageAvailable: false }), { code: 'DEVICE_STORAGE_UNAVAILABLE' });
  await assert.rejects(getOrCreateMachineId(options), { code: 'DEVICE_IDENTITY_LOCK_UNAVAILABLE' });
  assert.equal(storageCalls, 0);
});

test('rejects invalid stored and generated identifiers rather than persisting them', async () => {
  let stored = '../unsafe';
  let writes = 0;
  await assert.rejects(getOrCreateMachineId({
    deviceStorageAvailable: true,
    lockManager: withLock(),
    storage: {
      async get() { return stored; },
      async set(_key, value) { writes += 1; stored = value; },
    },
    randomUUID: () => '../unsafe',
  }), { code: 'MACHINE_ID_INVALID' });
  assert.equal(writes, 0);
});
