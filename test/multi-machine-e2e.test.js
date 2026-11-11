import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as nodeExecFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readRemoteMachineStates } from '../src/remote-state.js';
import { createServiceServer } from '../src/service.js';
import { createMachineState, mergeMachineStates } from '../src/state.js';

async function startServer(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

function fileKey(relativePath) {
  return `opencodeFile.k${Buffer.from(relativePath, 'utf8').toString('base64url')}`;
}

// Rewrites the GitHub remote used by the reader to a local bare repository so
// the full Git pipeline runs end-to-end without network access.
function localRepositoryReader(bare) {
  return (url) => readRemoteMachineStates(url, {
    execFile(file, args, options, callback) {
      const rewritten = [...args];
      const lsRemote = rewritten.indexOf('ls-remote');
      if (lsRemote >= 0) rewritten[rewritten.length - 1] = bare;
      const addRemote = rewritten.indexOf('add');
      if (addRemote >= 0 && rewritten[addRemote - 1] === 'remote') rewritten[addRemote + 2] = bare;
      nodeExecFile(file, rewritten, options, callback);
    },
  });
}

async function createConfigDirectories(root) {
  const openChamberDir = path.join(root, 'openchamber');
  const openCodeDir = path.join(root, 'opencode');
  await mkdir(path.join(openChamberDir), { recursive: true });
  await mkdir(path.join(openCodeDir, 'agents'), { recursive: true });
  await writeFile(path.join(openChamberDir, 'preferences.json'), JSON.stringify({ version: 1, fields: {} }));
  await writeFile(path.join(openChamberDir, 'extensions.json'), JSON.stringify({ gitOrigins: {} }));
  await writeFile(path.join(openCodeDir, 'opencode.json'), JSON.stringify({}));
  return { openChamberDir, openCodeDir };
}

// Creates a bare repository plus a scratch working repository used to publish
// machine states with plain Git commits.
function createRepositoryFixture(root) {
  const bare = path.join(root, 'remote.git');
  const working = path.join(root, 'working');
  execFileSync('git', ['init', '--bare', '--initial-branch=main', '--quiet', bare], { stdio: 'ignore' });
  execFileSync('git', ['-C', bare, 'config', 'uploadpack.allowFilter', 'true'], { stdio: 'ignore' });
  execFileSync('git', ['init', '--initial-branch=main', '--quiet', working], { stdio: 'ignore' });
  const identity = ['-c', 'user.name=Sync Test', '-c', 'user.email=sync@example.invalid'];
  return {
    bare,
    publish(states, message) {
      for (const { machineId, state } of states) {
        const statePath = path.join(working, 'machines', machineId, 'state.json');
        execFileSync('mkdir', ['-p', path.dirname(statePath)], { stdio: 'ignore' });
        execFileSync('tee', [statePath], { input: `${JSON.stringify(state, null, 2)}\n`, stdio: ['pipe', 'ignore', 'ignore'] });
      }
      execFileSync('git', ['-C', working, 'add', 'machines'], { stdio: 'ignore' });
      execFileSync('git', ['-C', working, ...identity, 'commit', '--allow-empty', '-m', message], { stdio: 'ignore' });
      execFileSync('git', ['-C', working, 'push', '--quiet', bare, 'HEAD:main'], { stdio: 'ignore' });
    },
  };
}

async function preview(origin, body) {
  const response = await fetch(`${origin}/repository/preview`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-service-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function apply(origin, body) {
  const response = await fetch(`${origin}/repository/apply`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-service-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('two machines converge through preview, confirmation, and apply', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openchamber-e2e-'));
  try {
    const { bare, publish } = createRepositoryFixture(root);
    publish([{
      machineId: 'machine-a',
      state: createMachineState({
        machineId: 'machine-a',
        values: {
          'preferences.darkThemeId': 'a-theme',
          'opencode.kbW9kZWw': 'provider/a',
          'extensions.repositories': ['https://github.com/acme/ext.git'],
          [fileKey('agents/review.md')]: 'Shared review instructions.',
        },
        now: 100,
      }),
    }], 'machine a initial state');

    const { openChamberDir, openCodeDir } = await createConfigDirectories(root);
    await writeFile(path.join(openCodeDir, 'agents', 'review.md'), 'Divergent review instructions.');
    const server = createServiceServer({
      token: 'test-service-token',
      openChamberDir,
      openCodeDir,
      stateReader: localRepositoryReader(bare),
    });
    const origin = await startServer(server);
    try {
      const first = await preview(origin, { url: 'https://github.com/acme/config.git', machineId: 'machine-b' });
      assert.equal(first.status, 200);
      assert.equal(first.body.comparison.canConfirm, true);
      assert.deepEqual(first.body.comparison.items.map((item) => item.action).sort(), ['conflict', 'conflict', 'download', 'download']);

      const applied = await apply(origin, {
        url: 'https://github.com/acme/config.git',
        machineId: 'machine-b',
        previewId: first.body.previewId,
        resolutions: 'RR',
        confirmed: true,
      });
      assert.equal(applied.status, 200);
      assert.equal(applied.body.changesMade, true);

      // A second comparison finds no differences: this machine converged.
      const second = await preview(origin, { url: 'https://github.com/acme/config.git', machineId: 'machine-b' });
      assert.equal(second.status, 200);
      assert.deepEqual(second.body.comparison, {
        ...second.body.comparison,
        localOnly: 0,
        remoteOnly: 0,
        conflicts: 0,
        unchanged: 4,
        items: [],
        canConfirm: true,
      });
      assert.equal(JSON.parse(await readFile(path.join(openChamberDir, 'preferences.json'), 'utf8')).fields.darkThemeId, 'a-theme');
      assert.equal(JSON.parse(await readFile(path.join(openCodeDir, 'opencode.json'), 'utf8')).model, 'provider/a');
      assert.equal(await readFile(path.join(openCodeDir, 'agents', 'review.md'), 'utf8'), 'Shared review instructions.');
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('repository deletions win when chosen, and tombstones block resurrection', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openchamber-e2e-'));
  try {
    const { bare, publish } = createRepositoryFixture(root);
    const initialState = createMachineState({
      machineId: 'machine-a',
      values: { 'preferences.notifyOnError': true, 'preferences.darkThemeId': 'a-theme' },
      now: 100,
    });
    publish([{ machineId: 'machine-a', state: initialState }], 'initial');
    const deletionState = createMachineState({
      machineId: 'machine-a',
      previous: initialState,
      values: { 'preferences.darkThemeId': 'a-theme' },
      now: 200,
    });
    publish([{ machineId: 'machine-a', state: deletionState }], 'machine a deletes notifyOnError');

    const { openChamberDir, openCodeDir } = await createConfigDirectories(root);
    const preferencesPath = path.join(openChamberDir, 'preferences.json');
    await writeFile(preferencesPath, JSON.stringify({ version: 1, fields: { notifyOnError: true } }));
    const server = createServiceServer({
      token: 'test-service-token',
      openChamberDir,
      openCodeDir,
      stateReader: localRepositoryReader(bare),
    });
    const origin = await startServer(server);
    try {
      const first = await preview(origin, { url: 'https://github.com/acme/config.git', machineId: 'machine-b' });
      assert.equal(first.status, 200);
      const deletionItem = first.body.comparison.items.find((item) => item.remote.deleted === true);
      assert.equal(deletionItem.action, 'conflict');

      const applied = await apply(origin, {
        url: 'https://github.com/acme/config.git',
        machineId: 'machine-b',
        previewId: first.body.previewId,
        resolutions: 'R'.repeat(first.body.comparison.conflicts),
        confirmed: true,
      });
      assert.equal(applied.status, 200);
      assert.equal(JSON.parse(await readFile(preferencesPath, 'utf8')).fields.notifyOnError, undefined);

      const second = await preview(origin, { url: 'https://github.com/acme/config.git', machineId: 'machine-b' });
      assert.equal(second.status, 200);
      assert.equal(second.body.comparison.conflicts, 0);

      // Recreating the value locally surfaces the tombstone again.
      await writeFile(preferencesPath, JSON.stringify({ version: 1, fields: { notifyOnError: true } }));
      const third = await preview(origin, { url: 'https://github.com/acme/config.git', machineId: 'machine-b' });
      assert.equal(third.status, 200);
      assert.equal(third.body.comparison.conflicts, 1);
      assert.equal(third.body.comparison.items.find((item) => item.remote.deleted === true)?.action, 'conflict');
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('equal-timestamp ties and long-offline machines resolve deterministically', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openchamber-e2e-'));
  try {
    const { bare, publish } = createRepositoryFixture(root);
    const tieState = (machineId, value) => ({
      version: 1,
      machineId,
      sequence: 1,
      entries: {
        'preferences.defaultModel': { timestamp: 100, sequence: 1, value },
      },
    });
    const offlineState = {
      version: 1,
      machineId: 'long-offline',
      sequence: 3,
      entries: {
        'preferences.monoFont': { timestamp: 10, sequence: 3, value: 'ancient-font' },
      },
    };
    const recentState = {
      version: 1,
      machineId: 'recent-machine',
      sequence: 1,
      entries: {
        'preferences.monoFont': { timestamp: 5000, sequence: 1, value: 'fresh-font' },
      },
    };
    publish([
      { machineId: 'tie-a', state: tieState('tie-a', 'alpha') },
      { machineId: 'tie-z', state: tieState('tie-z', 'zulu') },
      { machineId: 'long-offline', state: offlineState },
      { machineId: 'recent-machine', state: recentState },
    ], 'tie and offline states');
    assert.equal(mergeMachineStates([tieState('tie-a', 'alpha'), tieState('tie-z', 'zulu')]).values['preferences.defaultModel'], 'zulu');

    const { openChamberDir, openCodeDir } = await createConfigDirectories(root);
    const server = createServiceServer({
      token: 'test-service-token',
      openChamberDir,
      openCodeDir,
      stateReader: localRepositoryReader(bare),
    });
    const origin = await startServer(server);
    try {
      const result = await preview(origin, { url: 'https://github.com/acme/config.git', machineId: 'machine-b' });
      assert.equal(result.status, 200);
      const models = result.body.comparison.items.filter((item) => item.key === 'preferences.defaultModel');
      assert.equal(models.length, 1);
      assert.equal(models[0].remote.preview, '"zulu"');
      const fonts = result.body.comparison.items.filter((item) => item.key === 'preferences.monoFont');
      assert.equal(fonts.length, 1);
      assert.equal(fonts[0].remote.preview, '"fresh-font"');
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('apply rejects previews that are stale locally or remotely', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openchamber-e2e-'));
  try {
    const { bare, publish } = createRepositoryFixture(root);
    publish([{
      machineId: 'machine-a',
      state: createMachineState({
        machineId: 'machine-a',
        values: { 'preferences.darkThemeId': 'a-theme' },
        now: 100,
      }),
    }], 'initial');
    const { openChamberDir, openCodeDir } = await createConfigDirectories(root);
    const preferencesPath = path.join(openChamberDir, 'preferences.json');
    await writeFile(preferencesPath, JSON.stringify({ version: 1, fields: { darkThemeId: 'local-theme' } }));
    const server = createServiceServer({
      token: 'test-service-token',
      openChamberDir,
      openCodeDir,
      stateReader: localRepositoryReader(bare),
    });
    const origin = await startServer(server);
    try {
      const requestBody = () => ({
        url: 'https://github.com/acme/config.git',
        machineId: 'machine-b',
      });
      const first = await preview(origin, requestBody());
      assert.equal(first.status, 200);

      await writeFile(preferencesPath, JSON.stringify({ version: 1, fields: { darkThemeId: 'edited-locally' } }));
      const staleLocal = await apply(origin, { ...requestBody(), previewId: first.body.previewId, resolutions: 'R', confirmed: true });
      assert.equal(staleLocal.status, 409);
      assert.deepEqual(staleLocal.body, { error: 'preview-stale' });
      assert.equal(JSON.parse(await readFile(preferencesPath, 'utf8')).fields.darkThemeId, 'edited-locally');

      await writeFile(preferencesPath, JSON.stringify({ version: 1, fields: { darkThemeId: 'local-theme' } }));
      const second = await preview(origin, requestBody());
      assert.equal(second.status, 200);

      publish([{
        machineId: 'machine-c',
        state: createMachineState({ machineId: 'machine-c', values: { 'preferences.darkThemeId': 'c-theme' }, now: 300 }),
      }], 'machine c joins while a preview is open');
      const staleRemote = await apply(origin, { ...requestBody(), previewId: second.body.previewId, resolutions: 'R', confirmed: true });
      assert.equal(staleRemote.status, 409);
      assert.deepEqual(staleRemote.body, { error: 'preview-stale' });

      const fresh = await preview(origin, requestBody());
      const applied = await apply(origin, { ...requestBody(), previewId: fresh.body.previewId, resolutions: 'R', confirmed: true });
      assert.equal(applied.status, 200);
      assert.equal(JSON.parse(await readFile(preferencesPath, 'utf8')).fields.darkThemeId, 'c-theme');
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('malformed remote state fails closed through the whole pipeline', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openchamber-e2e-'));
  try {
    const { bare, publish } = createRepositoryFixture(root);
    publish([{ machineId: 'machine-a', state: { version: 1 } }], 'malformed state');
    const { openChamberDir, openCodeDir } = await createConfigDirectories(root);
    const server = createServiceServer({
      token: 'test-service-token',
      openChamberDir,
      openCodeDir,
      stateReader: localRepositoryReader(bare),
    });
    const origin = await startServer(server);
    try {
      const result = await preview(origin, { url: 'https://github.com/acme/config.git', machineId: 'machine-b' });
      assert.equal(result.status, 422);
      assert.deepEqual(result.body, { error: 'remote-state-invalid' });
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
