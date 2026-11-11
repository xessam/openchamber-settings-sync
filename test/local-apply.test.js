import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { applyPlanToFiles, defaultApplyJournalPath, recoverApplyJournal } from '../src/local-apply.js';

const FILE_KEY_TEXT = 'agents/review.md';

function fileKey(relativePath) {
  return `opencodeFile.k${Buffer.from(relativePath, 'utf8').toString('base64url')}`;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function basePlan() {
  return {
    settingChanges: {
      preferences: [{ kind: 'settings', target: 'preferences', key: 'darkThemeId', type: 'set', value: 'remote-theme' }],
      opencode: [{ kind: 'settings', target: 'opencode', key: 'model', type: 'set', value: 'provider/remote' }],
      extensions: [{
        kind: 'settings',
        target: 'extensions',
        key: 'repositories',
        type: 'set',
        value: ['https://example.com/repo.git', 'https://github.com/acme/ext.git'],
      }],
    },
    fileChanges: [
      { kind: 'file', relativePath: FILE_KEY_TEXT, type: 'write', text: 'Remote review instructions.' },
      { kind: 'file', relativePath: 'agents/removed.md', type: 'delete' },
    ],
    changeCount: 5,
  };
}

async function writeFixtures(root) {
  const openChamberDir = path.join(root, 'openchamber');
  const openCodeDir = path.join(root, 'opencode');
  await mkdir(path.join(openChamberDir), { recursive: true });
  await mkdir(path.join(openCodeDir, 'agents'), { recursive: true });
  await writeFile(path.join(openChamberDir, 'preferences.json'), `${JSON.stringify({
    version: '2',
    fields: { darkThemeId: 'local-theme', keepMe: 'untouched' },
    unrelated: { nested: true },
  }, null, 2)}\n`);
  await writeFile(path.join(openChamberDir, 'extensions.json'), `${JSON.stringify({
    gitOrigins: {
      one: { url: 'https://example.com/repo.git' },
      machineLocal: { url: '/opt/extensions/helper' },
    },
    storageIds: { one: 'keep-me' },
  }, null, 2)}\n`);
  await writeFile(path.join(openCodeDir, 'opencode.json'), `${JSON.stringify({
    model: 'provider/local',
    custom: { deep: { value: 1 } },
  }, null, 2)}\n`);
  await writeFile(path.join(openCodeDir, 'agents', 'review.md'), 'Local review instructions.');
  await writeFile(path.join(openCodeDir, 'agents', 'removed.md'), 'Remove me.');
  return { openChamberDir, openCodeDir };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function listFiles(directory) {
  return (await readdir(directory)).sort();
}

test('applies approved changes while preserving unsynced local fields', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openchamber-apply-'));
  try {
    const { openChamberDir, openCodeDir } = await writeFixtures(root);
    const result = await applyPlanToFiles(basePlan(), {
      openChamberDir,
      openCodeDir,
      planId: sha256('plan'),
    });
    assert.equal(result.applied, 5);
    assert.equal(result.recovered, false);

    const preferences = await readJson(path.join(openChamberDir, 'preferences.json'));
    assert.equal(preferences.version, '2');
    assert.equal(preferences.fields.darkThemeId, 'remote-theme');
    assert.equal(preferences.fields.keepMe, 'untouched');
    assert.deepEqual(preferences.unrelated, { nested: true });

    const opencode = await readJson(path.join(openCodeDir, 'opencode.json'));
    assert.equal(opencode.model, 'provider/remote');
    assert.deepEqual(opencode.custom, { deep: { value: 1 } });

    const extensions = await readJson(path.join(openChamberDir, 'extensions.json'));
    assert.equal(extensions.storageIds.one, 'keep-me');
    assert.equal(extensions.gitOrigins.one.url, 'https://example.com/repo.git');
    assert.equal(extensions.gitOrigins.machineLocal.url, '/opt/extensions/helper');
    const newOrigins = Object.values(extensions.gitOrigins).filter((origin) => origin.url === 'https://github.com/acme/ext.git');
    assert.equal(newOrigins.length, 1);

    assert.equal(await readFile(path.join(openCodeDir, 'agents', 'review.md'), 'utf8'), 'Remote review instructions.');
    assert.equal(await readdir(path.join(openCodeDir, 'agents')).then((entries) => entries.includes('removed.md')), false);
    assert.equal(await readdir(openChamberDir).then((entries) => entries.includes('.openchamber-sync-apply-journal.json')), false);
    assert.deepEqual(await listFiles(path.join(openCodeDir, 'agents')), ['review.md']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('writes new files with parent directories and applies tombstones', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openchamber-apply-'));
  try {
    const openChamberDir = path.join(root, 'openchamber');
    const openCodeDir = path.join(root, 'opencode');
    await mkdir(openChamberDir);
    await mkdir(openCodeDir);
    await writeFile(path.join(openChamberDir, 'preferences.json'), JSON.stringify({ version: 1, fields: {} }));
    await writeFile(path.join(openChamberDir, 'extensions.json'), JSON.stringify({ gitOrigins: {} }));
    await writeFile(path.join(openCodeDir, 'opencode.json'), JSON.stringify({}));
    const plan = {
      settingChanges: {
        preferences: [{ kind: 'settings', target: 'preferences', key: 'monoFont', type: 'set', value: 'monospace' }],
        opencode: [],
        extensions: [],
      },
      fileChanges: [
        { kind: 'file', relativePath: 'commands/nested/build.cjs', type: 'write', text: 'module.exports = 1;\n' },
      ],
      changeCount: 2,
    };
    await applyPlanToFiles(plan, { openChamberDir, openCodeDir, planId: sha256('plan') });
    assert.equal(await readFile(path.join(openCodeDir, 'commands', 'nested', 'build.cjs'), 'utf8'), 'module.exports = 1;\n');
    const preferences = await readJson(path.join(openChamberDir, 'preferences.json'));
    assert.equal(preferences.fields.monoFont, 'monospace');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses symlinked targets and missing settings files without changing anything', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openchamber-apply-'));
  try {
    const { openChamberDir, openCodeDir } = await writeFixtures(root);
    await rm(path.join(openCodeDir, 'opencode.json'));
    await symlink(path.join(root, 'elsewhere.json'), path.join(openCodeDir, 'opencode.json'));
    await assert.rejects(
      () => applyPlanToFiles(basePlan(), { openChamberDir, openCodeDir, planId: sha256('plan') }),
      (error) => error.code === 'APPLY_TARGET_UNAVAILABLE',
    );
    assert.equal(await readJson(path.join(openChamberDir, 'preferences.json')).then((value) => value.fields.darkThemeId), 'local-theme');
    assert.equal(await readFile(path.join(openCodeDir, 'agents', 'review.md'), 'utf8'), 'Local review instructions.');

    const missingRoot = path.join(root, 'missing');
    await mkdir(missingRoot);
    await assert.rejects(
      () => applyPlanToFiles(basePlan(), { openChamberDir: missingRoot, openCodeDir, planId: sha256('plan') }),
      (error) => error.code === 'APPLY_TARGET_UNAVAILABLE',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an interruption before any write leaves every file untouched and the next apply recovers', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openchamber-apply-'));
  try {
    const { openChamberDir, openCodeDir } = await writeFixtures(root);
    await assert.rejects(
      () => applyPlanToFiles(basePlan(), { openChamberDir, openCodeDir, planId: sha256('plan'), crashPhase: 'journal' }),
      (error) => error.code === 'SIMULATED_CRASH',
    );
    assert.equal(await readJson(path.join(openChamberDir, 'preferences.json')).then((value) => value.fields.darkThemeId), 'local-theme');
    assert.equal(await readFile(path.join(openCodeDir, 'agents', 'review.md'), 'utf8'), 'Local review instructions.');

    const result = await applyPlanToFiles(basePlan(), { openChamberDir, openCodeDir, planId: sha256('plan-2') });
    assert.equal(result.recovered, true);
    assert.equal(result.applied, 5);
    assert.equal(await readJson(path.join(openChamberDir, 'preferences.json')).then((value) => value.fields.darkThemeId), 'remote-theme');
    assert.equal(await readFile(path.join(openCodeDir, 'agents', 'review.md'), 'utf8'), 'Remote review instructions.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an interruption mid-write is rolled back on the next apply without losing local data', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openchamber-apply-'));
  try {
    const { openChamberDir, openCodeDir } = await writeFixtures(root);
    await assert.rejects(
      () => applyPlanToFiles(basePlan(), { openChamberDir, openCodeDir, planId: sha256('plan'), crashPhase: 'write', crashAfterSteps: 2 }),
      (error) => error.code === 'SIMULATED_CRASH',
    );
    // At least one step was applied before the simulated crash.
    const partialPreferences = await readJson(path.join(openChamberDir, 'preferences.json'));
    assert.ok(partialPreferences.fields.darkThemeId === 'remote-theme' || partialPreferences.fields.darkThemeId === 'local-theme');

    const result = await applyPlanToFiles(basePlan(), { openChamberDir, openCodeDir, planId: sha256('plan-2') });
    assert.equal(result.recovered, true);
    const preferences = await readJson(path.join(openChamberDir, 'preferences.json'));
    assert.equal(preferences.fields.darkThemeId, 'remote-theme');
    assert.equal(preferences.fields.keepMe, 'untouched');
    assert.equal(await readFile(path.join(openCodeDir, 'agents', 'review.md'), 'utf8'), 'Remote review instructions.');
    assert.equal(await readdir(path.join(openCodeDir, 'agents')).then((entries) => entries.includes('removed.md')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('explicit recovery restores the pre-apply state after a cleanup-phase crash', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openchamber-apply-'));
  try {
    const { openChamberDir, openCodeDir } = await writeFixtures(root);
    await assert.rejects(
      () => applyPlanToFiles(basePlan(), { openChamberDir, openCodeDir, planId: sha256('plan'), crashPhase: 'cleanup' }),
      (error) => error.code === 'SIMULATED_CRASH',
    );
    const applied = await readJson(path.join(openChamberDir, 'preferences.json'));
    assert.equal(applied.fields.darkThemeId, 'remote-theme');

    const recovery = await recoverApplyJournal({ journalPath: defaultApplyJournalPath(openChamberDir) });
    assert.equal(recovery.recovered, true);
    assert.equal(recovery.rolledBack, 5);
    const preferences = await readJson(path.join(openChamberDir, 'preferences.json'));
    assert.equal(preferences.fields.darkThemeId, 'local-theme');
    assert.equal(preferences.fields.keepMe, 'untouched');
    assert.equal(await readFile(path.join(openCodeDir, 'agents', 'review.md'), 'utf8'), 'Local review instructions.');
    assert.equal(await readFile(path.join(openCodeDir, 'agents', 'removed.md'), 'utf8'), 'Remove me.');
    assert.equal(await readdir(openChamberDir).then((entries) => entries.includes('.openchamber-sync-apply-journal.json')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recovery never overwrites a file the user edited after the interrupted apply', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openchamber-apply-'));
  try {
    const { openChamberDir, openCodeDir } = await writeFixtures(root);
    await assert.rejects(
      () => applyPlanToFiles(basePlan(), { openChamberDir, openCodeDir, planId: sha256('plan'), crashPhase: 'write', crashAfterSteps: 1 }),
      (error) => error.code === 'SIMULATED_CRASH',
    );
    await writeFile(path.join(openCodeDir, 'agents', 'review.md'), 'User edited this after the crash.');

    const recovery = await recoverApplyJournal({ journalPath: defaultApplyJournalPath(openChamberDir) });
    assert.equal(recovery.recovered, true);
    assert.equal(await readFile(path.join(openCodeDir, 'agents', 'review.md'), 'utf8'), 'User edited this after the crash.');
    // The pre-apply value is preserved in the untouched preferences file.
    const preferences = await readJson(path.join(openChamberDir, 'preferences.json'));
    assert.ok(['local-theme', 'remote-theme'].includes(preferences.fields.darkThemeId));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an invalid recovery marker fails closed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openchamber-apply-'));
  try {
    const { openChamberDir, openCodeDir } = await writeFixtures(root);
    await writeFile(defaultApplyJournalPath(openChamberDir), '{"version":1,"planId":"nope"}');
    await assert.rejects(
      () => applyPlanToFiles(basePlan(), { openChamberDir, openCodeDir, planId: sha256('plan') }),
      (error) => error.code === 'APPLY_JOURNAL_INVALID',
    );
    await assert.rejects(
      () => recoverApplyJournal({ journalPath: defaultApplyJournalPath(openChamberDir) }),
      (error) => error.code === 'APPLY_JOURNAL_INVALID',
    );
    assert.equal(await readJson(path.join(openChamberDir, 'preferences.json')).then((value) => value.fields.darkThemeId), 'local-theme');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('applies preference field removals and keeps local extensions untouched', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openchamber-apply-'));
  try {
    const { openChamberDir, openCodeDir } = await writeFixtures(root);
    const plan = {
      settingChanges: {
        preferences: [{ kind: 'settings', target: 'preferences', key: 'keepMe', type: 'remove' }],
        opencode: [{ kind: 'settings', target: 'opencode', key: 'custom', type: 'remove' }],
        extensions: [{
          kind: 'settings',
          target: 'extensions',
          key: 'repositories',
          type: 'set',
          value: ['https://github.com/acme/ext.git'],
        }],
      },
      fileChanges: [],
      changeCount: 3,
    };
    await applyPlanToFiles(plan, { openChamberDir, openCodeDir, planId: sha256('plan') });
    const preferences = await readJson(path.join(openChamberDir, 'preferences.json'));
    assert.equal(preferences.fields.keepMe, undefined);
    assert.equal(preferences.fields.darkThemeId, 'local-theme');
    const opencode = await readJson(path.join(openCodeDir, 'opencode.json'));
    assert.equal(opencode.custom, undefined);
    assert.equal(opencode.model, 'provider/local');
    const extensions = await readJson(path.join(openChamberDir, 'extensions.json'));
    assert.deepEqual(Object.values(extensions.gitOrigins).map((origin) => origin.url).sort(), [
      '/opt/extensions/helper',
      'https://github.com/acme/ext.git',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
