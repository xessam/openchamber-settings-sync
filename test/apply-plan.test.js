import test from 'node:test';
import assert from 'node:assert/strict';

import { planApplyChanges } from '../src/apply-plan.js';

function fileKey(relativePath) {
  return `opencodeFile.k${Buffer.from(relativePath, 'utf8').toString('base64url')}`;
}

function item(key, action, { remoteDeleted = false } = {}) {
  return {
    key,
    path: key,
    kind: 'setting',
    action,
    local: { present: true, deleted: false, preview: '', complete: true },
    remote: { present: !remoteDeleted, deleted: remoteDeleted, preview: '', complete: true },
    complete: true,
  };
}

test('plans set and remove operations for approved download and conflict choices', () => {
  const plan = planApplyChanges({
    items: [
      item('preferences.darkThemeId', 'download'),
      item('preferences.notifyOnError', 'conflict', { remoteDeleted: true }),
      item('opencode.kbW9kZWw', 'conflict'),
      item(fileKey('agents/review.md'), 'download'),
      item('preferences.defaultModel', 'upload'),
      item('opencode.kbW90aGVy', 'conflict', { remoteDeleted: true }),
    ],
    remoteValues: {
      'preferences.darkThemeId': 'remote-theme',
      'opencode.kbW9kZWw': { b: 2, a: 1 },
      [fileKey('agents/review.md')]: 'Remote instructions.',
    },
    tombstones: ['preferences.notifyOnError', 'opencode.kbW90aGVy'],
    resolutions: 'RRR',
  });
  assert.deepEqual(plan.settingChanges.preferences, [
    { kind: 'settings', target: 'preferences', key: 'darkThemeId', type: 'set', value: 'remote-theme' },
    { kind: 'settings', target: 'preferences', key: 'notifyOnError', type: 'remove' },
  ]);
  assert.deepEqual(plan.settingChanges.opencode, [
    { kind: 'settings', target: 'opencode', key: 'model', type: 'set', value: { a: 1, b: 2 } },
    { kind: 'settings', target: 'opencode', key: 'mother', type: 'remove' },
  ]);
  assert.deepEqual(plan.settingChanges.extensions, []);
  assert.deepEqual(plan.fileChanges, [
    { kind: 'file', relativePath: 'agents/review.md', type: 'write', text: 'Remote instructions.' },
  ]);
  assert.equal(plan.changeCount, 5);
});

test('plans file deletion and extension removal for resolved conflicts', () => {
  const plan = planApplyChanges({
    items: [
      item(fileKey('agents/old.md'), 'conflict', { remoteDeleted: true }),
      item('extensions.repositories', 'conflict'),
    ],
    remoteValues: { 'extensions.repositories': ['https://github.com/acme/ext.git'] },
    tombstones: [fileKey('agents/old.md')],
    resolutions: 'RR',
  });
  assert.deepEqual(plan.fileChanges, [
    { kind: 'file', relativePath: 'agents/old.md', type: 'delete' },
  ]);
  assert.deepEqual(plan.settingChanges.extensions, [
    {
      kind: 'settings',
      target: 'extensions',
      key: 'repositories',
      type: 'set',
      value: ['https://github.com/acme/ext.git'],
    },
  ]);
});

test('reports nothing to apply when every choice keeps the local value', () => {
  const base = { remoteValues: { 'preferences.darkThemeId': 'remote-theme' }, tombstones: [] };
  assert.throws(() => planApplyChanges({
    ...base,
    items: [item('preferences.darkThemeId', 'conflict')],
    resolutions: 'L',
  }), (error) => error.code === 'NOTHING_TO_APPLY');
  assert.throws(() => planApplyChanges({
    ...base,
    items: [item('preferences.darkThemeId', 'upload')],
    resolutions: '',
  }), (error) => error.code === 'NOTHING_TO_APPLY');
});

test('rejects unsupported keys, unsafe values, and inconsistent resolutions', () => {
  const base = { remoteValues: {}, tombstones: [], resolutions: '' };
  assert.throws(() => planApplyChanges({
    ...base,
    items: [item('preferences.notPortable', 'download')],
    remoteValues: { 'preferences.notPortable': 'x' },
  }), (error) => error.code === 'INVALID_PLAN');
  assert.throws(() => planApplyChanges({
    ...base,
    items: [item('unexpected.key', 'download')],
    remoteValues: { 'unexpected.key': 'x' },
  }), (error) => error.code === 'INVALID_PLAN');
  assert.throws(() => planApplyChanges({
    ...base,
    items: [item(fileKey('agents/leak.md'), 'download')],
    remoteValues: { [fileKey('agents/leak.md')]: 'api_key = "super-secret-value"' },
  }), (error) => error.code === 'INVALID_PLAN');
  assert.throws(() => planApplyChanges({
    ...base,
    items: [item(fileKey('agents/../evil.md'), 'download')],
    remoteValues: { [fileKey('agents/../evil.md')]: 'text' },
  }), (error) => error.code === 'INVALID_PLAN');
  assert.throws(() => planApplyChanges({
    ...base,
    items: [item('extensions.repositories', 'download')],
    remoteValues: { 'extensions.repositories': ['http://insecure.example.com/x'] },
  }), (error) => error.code === 'INVALID_PLAN');
  assert.throws(() => planApplyChanges({
    ...base,
    items: [item('extensions.repositories', 'download')],
    remoteValues: { 'extensions.repositories': ['https://user:pass@example.com/x.git'] },
  }), (error) => error.code === 'INVALID_PLAN');
  assert.throws(() => planApplyChanges({
    ...base,
    items: [item('preferences.darkThemeId', 'conflict')],
    remoteValues: { 'preferences.darkThemeId': 'remote-theme' },
    resolutions: '',
  }), (error) => error.code === 'INVALID_PLAN');
  assert.throws(() => planApplyChanges({
    ...base,
    items: [item('preferences.darkThemeId', 'conflict')],
    remoteValues: {},
    resolutions: 'R',
  }), (error) => error.code === 'INVALID_PLAN');
});
