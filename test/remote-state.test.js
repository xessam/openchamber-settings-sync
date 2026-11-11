import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as nodeExecFile, execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createMachineState } from '../src/state.js';
import { readRemoteMachineStates } from '../src/remote-state.js';

function treeRecord(machineId, { mode = '100644', type = 'blob' } = {}) {
  return Buffer.from(`${mode} ${type} ${'a'.repeat(40)}\tmachines/${machineId}/state.json\0`);
}

function fakeGit({ refs = 'a'.repeat(40) + '\trefs/heads/main\n', tree, state, onCall = () => {} } = {}) {
  const calls = [];
  const execFile = (file, args, options, callback) => {
    calls.push({ file, args, options });
    onCall(args);
    const command = args.find((part) => ['ls-remote', 'init', 'remote', 'fetch', 'rev-parse', 'ls-tree', 'show'].includes(part));
    if (command === 'ls-remote') return callback(null, Buffer.from(refs), Buffer.alloc(0));
    if (command === 'rev-parse') return callback(null, Buffer.from('a'.repeat(40)), Buffer.alloc(0));
    if (command === 'ls-tree') return callback(null, tree ?? Buffer.alloc(0), Buffer.alloc(0));
    if (command === 'show') return callback(null, Buffer.from(JSON.stringify(state)), Buffer.alloc(0));
    return callback(null, Buffer.alloc(0), Buffer.alloc(0));
  };
  return { calls, execFile };
}

test('reads and validates per-machine states without checking out repository files', async () => {
  const state = createMachineState({ machineId: 'laptop', values: { 'preferences.darkThemeId': 'dark' }, now: 10 });
  const git = fakeGit({ tree: treeRecord('laptop'), state });
  const result = await readRemoteMachineStates('git@github.com:acme/config.git', { execFile: git.execFile });

  assert.deepEqual(result, { empty: false, states: [state] });
  assert.equal(git.calls.some(({ args }) => args.some((arg) => ['checkout', 'clone', 'archive'].includes(arg))), false);
  assert.deepEqual(git.calls[0].args.slice(-3), ['ls-remote', '--heads', 'git@github.com:acme/config.git']);
  assert.equal(git.calls.some(({ args }) => args.includes('--filter=blob:none')), true);
  assert.equal(git.calls.every(({ options }) => options.shell === false
    && options.timeout > 0 && options.timeout <= 10_000 && options.maxBuffer > 0), true);
  assert.equal(git.calls.every(({ options }) => options.env.GIT_TERMINAL_PROMPT === '0'), true);
});

test('reads a local bare test repository through the same Git plumbing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'remote-state-integration-'));
  const working = path.join(root, 'working');
  const bare = path.join(root, 'remote.git');
  const emptyBare = path.join(root, 'empty.git');
  const expected = createMachineState({ machineId: 'desktop', values: { 'preferences.darkThemeId': 'night' }, now: 42 });
  let temporaryDirectory;
  try {
    execFileSync('git', ['init', '--bare', '--initial-branch=main', bare], { stdio: 'ignore' });
    execFileSync('git', ['init', '--bare', '--initial-branch=main', emptyBare], { stdio: 'ignore' });
    execFileSync('git', ['-C', bare, 'config', 'uploadpack.allowFilter', 'true'], { stdio: 'ignore' });
    execFileSync('git', ['init', '--initial-branch=main', working], { stdio: 'ignore' });
    const statePath = path.join(working, 'machines', 'desktop', 'state.json');
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify(expected));
    execFileSync('git', ['-C', working, 'add', 'machines/desktop/state.json'], { stdio: 'ignore' });
    execFileSync('git', ['-C', working, '-c', 'user.name=Sync Test', '-c', 'user.email=sync@example.invalid', 'commit', '-m', 'state'], { stdio: 'ignore' });
    execFileSync('git', ['-C', working, 'push', bare, 'HEAD:main'], { stdio: 'ignore' });

    const result = await readRemoteMachineStates('git@github.com:acme/config.git', {
      execFile(file, args, options, callback) {
        const rewritten = [...args];
        const init = rewritten.indexOf('init');
        if (init >= 0) temporaryDirectory = path.dirname(rewritten.at(-1));
        const lsRemote = rewritten.indexOf('ls-remote');
        if (lsRemote >= 0) rewritten[rewritten.length - 1] = bare;
        const addRemote = rewritten.indexOf('add');
        if (addRemote >= 0 && rewritten[addRemote - 1] === 'remote') rewritten[addRemote + 2] = bare;
        nodeExecFile(file, rewritten, options, callback);
      },
    });
    assert.deepEqual(result, { empty: false, states: [expected] });
    await assert.rejects(lstat(temporaryDirectory), { code: 'ENOENT' });

    const empty = await readRemoteMachineStates('git@github.com:acme/empty.git', {
      execFile(file, args, options, callback) {
        const rewritten = [...args];
        const lsRemote = rewritten.indexOf('ls-remote');
        if (lsRemote >= 0) rewritten[rewritten.length - 1] = emptyBare;
        nodeExecFile(file, rewritten, options, callback);
      },
    });
    assert.deepEqual(empty, { empty: true, states: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recognizes an empty repository without treating remote access failures as empty', async () => {
  const empty = fakeGit({ refs: '' });
  assert.deepEqual(await readRemoteMachineStates('https://github.com/acme/config.git', { execFile: empty.execFile }), {
    empty: true,
    states: [],
  });
  assert.equal(empty.calls.length, 1);

  await assert.rejects(readRemoteMachineStates('https://github.com/acme/config.git', {
    execFile(_file, _args, _options, callback) {
      callback(Object.assign(new Error('private remote detail'), { code: 128 }), '', 'private remote detail');
    },
  }), (error) => {
    assert.equal(error.code, 'GIT_ACCESS_FAILED');
    assert.doesNotMatch(error.message, /private remote detail/);
    return true;
  });
});

test('rejects unexpected paths, symlink entries, and state-machine identity mismatches', async () => {
  const validState = createMachineState({ machineId: 'laptop', values: {}, now: 10 });
  for (const { tree, state } of [
    { tree: Buffer.from(`100644 blob ${'a'.repeat(40)}\tmachines/../state.json\0`), state: validState },
    { tree: treeRecord('laptop', { mode: '120000' }), state: validState },
    { tree: treeRecord('other-machine'), state: validState },
  ]) {
    const git = fakeGit({ tree, state });
    await assert.rejects(
      readRemoteMachineStates('https://github.com/acme/config.git', { execFile: git.execFile }),
      (error) => error.code === 'REMOTE_STATE_INVALID',
    );
  }
});

test('rejects malformed state JSON and states exceeding the size bound', async () => {
  const tree = treeRecord('laptop');
  const malformed = fakeGit({ tree, state: 'not-json' });
  await assert.rejects(
    readRemoteMachineStates('https://github.com/acme/config.git', { execFile: malformed.execFile }),
    (error) => error.code === 'REMOTE_STATE_INVALID',
  );

  const huge = fakeGit({ tree });
  huge.execFile = (file, args, options, callback) => {
    const command = args.find((part) => part === 'show');
    if (command) return callback(null, Buffer.alloc(9 * 1024 * 1024, 0x20), Buffer.alloc(0));
    fakeGit({ tree }).execFile(file, args, options, callback);
  };
  await assert.rejects(
    readRemoteMachineStates('https://github.com/acme/config.git', { execFile: huge.execFile }),
    (error) => error.code === 'REMOTE_STATE_TOO_LARGE',
  );
});

test('bounds the number of entries in an otherwise valid machine state', async () => {
  const values = Object.fromEntries(Array.from({ length: 4097 }, (_, index) => [`preferences.f${index}`, index]));
  const state = createMachineState({ machineId: 'laptop', values, now: 10 });
  const git = fakeGit({ tree: treeRecord('laptop'), state });
  await assert.rejects(
    readRemoteMachineStates('https://github.com/acme/config.git', { execFile: git.execFile }),
    (error) => error.code === 'REMOTE_STATE_TOO_LARGE',
  );
});

test('rejects credential-bearing and non-GitHub remotes before starting Git', async () => {
  let calls = 0;
  for (const remote of [
    'https://user:secret@github.com/acme/config.git',
    'https://example.com/acme/config.git',
  ]) {
    await assert.rejects(readRemoteMachineStates(remote, {
      execFile() { calls += 1; },
    }), (error) => error.code === 'INVALID_REPOSITORY_REMOTE');
  }
  assert.equal(calls, 0);
});

test('stops before starting another Git process after the total deadline', async () => {
  let calls = 0;
  let time = 0;
  await assert.rejects(readRemoteMachineStates('https://github.com/acme/config.git', {
    now: () => {
      const current = time;
      time += 50_000;
      return current;
    },
    execFile() { calls += 1; },
  }), (error) => error.code === 'GIT_TIMEOUT');
  assert.equal(calls, 0);
});

test('fails closed when the remote server ignores blob filtering', async () => {
  const git = fakeGit({ tree: treeRecord('laptop'), state: createMachineState({ machineId: 'laptop', values: {}, now: 10 }) });
  await assert.rejects(readRemoteMachineStates('https://github.com/acme/config.git', {
    execFile(file, args, options, callback) {
      if (args.includes('fetch')) {
        return callback(null, Buffer.alloc(0), Buffer.from('warning: filtering not recognized by server, ignoring'));
      }
      git.execFile(file, args, options, callback);
    },
  }), (error) => error.code === 'REMOTE_FILTER_UNSUPPORTED');
});
