import test from 'node:test';
import assert from 'node:assert/strict';

import { createBootstrapPreview } from '../src/bootstrap-preview.js';

test('previews file-level first-sync changes without writing either side', () => {
  const local = {
    sources: { preferences: { status: 'ready' }, opencode: { status: 'ready' }, 'opencode-files': { status: 'ready' }, extensions: { status: 'missing' } },
    values: { 'preferences.darkThemeId': 'local-secret-value', 'preferences.monoFont': 'same', 'opencode.kbW9kZWw': 'local-only' },
  };
  const states = [{ version: 1, machineId: 'other', sequence: 3, entries: {
    'preferences.darkThemeId': { timestamp: 1, sequence: 1, value: 'remote-secret-value' },
    'preferences.monoFont': { timestamp: 1, sequence: 2, value: 'same' },
    'opencode.kYWdlbnQ': { timestamp: 1, sequence: 3, value: 'remote-only' },
  } }];
  const before = JSON.stringify({ local, states });
  const preview = createBootstrapPreview(local, states);
  assert.deepEqual({
    localOnly: preview.localOnly,
    remoteOnly: preview.remoteOnly,
    conflicts: preview.conflicts,
    unchanged: preview.unchanged,
    blockedSources: preview.blockedSources,
    canConfirm: preview.canConfirm,
  }, { localOnly: 1, remoteOnly: 1, conflicts: 1, unchanged: 1, blockedSources: ['extensions'], canConfirm: false });
  assert.deepEqual(preview.items.map(({ path, action }) => [path, action]), [
    ['OpenChamber preferences · darkThemeId', 'conflict'],
    ['OpenCode opencode.json · agent', 'download'],
    ['OpenCode opencode.json · model', 'upload'],
  ]);
  assert.equal(preview.items[0].local.preview, '"local-secret-value"');
  assert.equal(preview.items[0].remote.preview, '"remote-secret-value"');
  assert.equal(preview.items[0].key, 'preferences.darkThemeId');
  assert.equal(preview.items.every((item) => item.complete), true);
  assert.equal(JSON.stringify({ local, states }), before);
});

test('unavailable sources block first sync instead of becoming deletes', () => {
  const preview = createBootstrapPreview({
    sources: { preferences: { status: 'unavailable' }, opencode: { status: 'missing' }, 'opencode-files': { status: 'unavailable' }, extensions: { status: 'ready' } },
    values: {},
  }, []);
  assert.deepEqual(preview.blockedSources, ['preferences', 'opencode', 'opencode-files']);
  assert.equal(preview.canConfirm, false);
});

test('a remote tombstone against a local value is a conflict, not a new upload', () => {
  const local = { sources: {}, values: { 'preferences.darkThemeId': 'local' } };
  const states = [{ version: 1, machineId: 'other', sequence: 1, entries: {
    'preferences.darkThemeId': { timestamp: 1, sequence: 1, deleted: true },
  } }];
  const preview = createBootstrapPreview(local, states);
  assert.equal(preview.conflicts, 1);
  assert.equal(preview.localOnly, 0);
});

test('withholds credential-like values and blocks confirmation for incomplete reviews', () => {
  const preview = createBootstrapPreview({
    sources: { preferences: { status: 'ready' }, opencode: { status: 'ready' }, 'opencode-files': { status: 'ready' }, extensions: { status: 'ready' } },
    values: { 'opencodeFile.kYWdlbnRzL3Jldmlldy5tZA': 'api_key = "must-not-display"' },
  }, []);
  assert.equal(preview.items[0].complete, false);
  assert.equal(preview.items[0].local.preview, '[hidden: credential-like content]');
  assert.equal(preview.canConfirm, false);
  assert.doesNotMatch(JSON.stringify(preview), /must-not-display/);
});

test('withholds secrets under credential-named keys in untrusted remote values', () => {
  const preview = createBootstrapPreview({
    sources: { preferences: { status: 'ready' }, opencode: { status: 'ready' }, 'opencode-files': { status: 'ready' }, extensions: { status: 'ready' } },
    values: {},
  }, [{ version: 1, machineId: 'remote', sequence: 1, entries: {
    'opencode.kbW9kZWw': { timestamp: 1, sequence: 1, value: { provider: { apiKey: 'remote-private-value' } } },
  } }]);
  assert.equal(preview.items[0].remote.preview, '[hidden: credential-like content]');
  assert.equal(preview.canConfirm, false);
  assert.doesNotMatch(JSON.stringify(preview), /remote-private-value/);
});

test('blocks malformed remote extension repository values instead of previewing an apply', () => {
  const preview = createBootstrapPreview({
    sources: { preferences: { status: 'ready' }, opencode: { status: 'ready' }, 'opencode-files': { status: 'ready' }, extensions: { status: 'ready' } },
    values: { 'extensions.repositories': [] },
  }, [{ version: 1, machineId: 'remote', sequence: 1, entries: {
    'extensions.repositories': { timestamp: 1, sequence: 1, value: ['javascript:alert(1)'] },
  } }]);
  assert.equal(preview.unsupportedItems, 1);
  assert.equal(preview.canConfirm, false);
  assert.equal(preview.items.length, 0);
  assert.doesNotMatch(JSON.stringify(preview), /javascript:/);
});

test('rejects malformed remote machine state', () => {
  assert.throws(() => createBootstrapPreview({ sources: {}, values: {} }, [{ version: 1, entries: {} }]), /Invalid machine state/);
});
