import test from 'node:test';
import assert from 'node:assert/strict';

import { createRepositoryBootstrapState } from '../src/repository-bootstrap.js';

const machineId = '550e8400-e29b-41d4-a716-446655440000';
const sources = {
  preferences: { status: 'ready' },
  opencode: { status: 'ready' },
  'opencode-files': { status: 'ready' },
  extensions: { status: 'ready' },
};

test('prepares one initial machine state file for an empty repository', () => {
  const local = { sources, values: { 'preferences.darkThemeId': 'dark', 'opencode.kbW9kZWw': 'provider/model' } };
  const before = JSON.stringify(local);
  const bootstrap = createRepositoryBootstrapState({
    machineId,
    local,
    remote: { empty: true, states: [] },
    now: 123,
  });
  assert.equal(bootstrap.path, `machines/${machineId}/state.json`);
  assert.equal(JSON.parse(bootstrap.content).machineId, machineId);
  assert.equal(JSON.parse(bootstrap.content).entries['preferences.darkThemeId'].value, 'dark');
  assert.equal(bootstrap.content.endsWith('\n'), true);
  assert.equal(JSON.stringify(local), before);
});

test('bootstraps a repository whose main has unrelated content but no machine state', () => {
  const bootstrap = createRepositoryBootstrapState({
    machineId,
    local: { sources, values: { 'preferences.darkThemeId': 'dark' } },
    remote: { empty: false, states: [] },
    now: 123,
  });
  assert.equal(bootstrap.path, `machines/${machineId}/state.json`);
});

test('refuses to bootstrap a repository that already contains machine states', () => {
  assert.throws(() => createRepositoryBootstrapState({
    machineId,
    local: { sources, values: {} },
    remote: { empty: false, states: [{ machineId: 'other', version: 1, sequence: 1, entries: {} }] },
    now: 123,
  }), (error) => error.code === 'REPOSITORY_NOT_EMPTY');
});

test('refuses incomplete local sources instead of interpreting them as initial deletions', () => {
  assert.throws(() => createRepositoryBootstrapState({
    machineId,
    local: { sources: { ...sources, opencode: { status: 'unavailable' } }, values: {} },
    remote: { empty: true, states: [] },
    now: 123,
  }), (error) => error.code === 'LOCAL_SOURCES_UNAVAILABLE');
});

test('rejects malformed machine ids and an inconsistent empty-remote result', () => {
  assert.throws(() => createRepositoryBootstrapState({
    machineId: '../bad', local: { sources, values: {} }, remote: { empty: true, states: [] }, now: 123,
  }), /machine id/i);
  assert.throws(() => createRepositoryBootstrapState({
    machineId, local: { sources, values: {} }, remote: { empty: true, states: [{}] }, now: 123,
  }), (error) => error.code === 'REPOSITORY_NOT_EMPTY');
});
