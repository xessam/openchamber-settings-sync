import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as nodeExecFile, execFileSync } from 'node:child_process';
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createMachineState, stableJson } from '../src/state.js';
import { pushBootstrapState } from '../src/repository-push.js';

const machineId = '550e8400-e29b-41d4-a716-446655440000';
const statePath = `machines/${machineId}/state.json`;
const commands = ['ls-remote', 'init', 'remote', 'config', 'fetch', 'rev-parse', 'ls-tree', 'hash-object', 'update-index', 'read-tree', 'write-tree', 'commit-tree', 'update-ref', 'push'];

function fakeGit({ onPush, refs = '' } = {}) {
  const calls = [];
  const execFile = (file, args, options, callback) => {
    calls.push({ file, args, options });
    const command = args.find((part) => commands.includes(part));
    if (command === 'ls-remote') return callback(null, Buffer.from(refs), Buffer.alloc(0));
    if (command === 'hash-object' || command === 'write-tree' || command === 'rev-parse') {
      return callback(null, Buffer.from('b'.repeat(40)), Buffer.alloc(0));
    }
    if (command === 'commit-tree') return callback(null, Buffer.from('c'.repeat(40)), Buffer.alloc(0));
    if (command === 'push') {
      if (onPush) return onPush(callback);
      return callback(null, Buffer.alloc(0), Buffer.from(' * [new branch]      main -> main\n'));
    }
    return callback(null, Buffer.alloc(0), Buffer.alloc(0));
  };
  return { calls, execFile };
}

function commandOf(call) {
  return call.args.find((part) => commands.includes(part));
}

test('creates the initial commit with Git plumbing and pushes it without force', async () => {
  const git = fakeGit();
  const content = `${JSON.stringify({ version: 1, machineId }, null, 2)}\n`;
  const result = await pushBootstrapState({
    url: 'https://github.com/acme/config.git',
    branch: 'main',
    path: statePath,
    content,
    commitTimestamp: 1234567890000,
    execFile: git.execFile,
  });

  assert.deepEqual(result, { commit: 'c'.repeat(40), branch: 'main', unchanged: false });
  assert.deepEqual(git.calls.map(commandOf), ['init', 'ls-remote', 'hash-object', 'update-index', 'write-tree', 'commit-tree', 'update-ref', 'push']);
  assert.equal(git.calls.some(({ args }) => args.some((arg) => ['checkout', 'clone', 'archive', 'reset'].includes(arg))), false);
  assert.equal(git.calls.some(({ args }) => args.includes('--force') || args.includes('-f') || args.includes('--force-with-lease')), false);

  const updateIndex = git.calls.find(({ args }) => args.includes('update-index'));
  assert.deepEqual(updateIndex.args.slice(-5), ['--add', '--cacheinfo', '100644', 'b'.repeat(40), statePath]);

  const commitTree = git.calls.find(({ args }) => args.includes('commit-tree'));
  assert.deepEqual(commitTree.args.slice(-4), ['commit-tree', 'b'.repeat(40), '-m', 'OpenChamber Sync: initial machine state']);
  assert.equal(commitTree.options.env.GIT_AUTHOR_NAME, 'OpenChamber Sync');
  assert.equal(commitTree.options.env.GIT_AUTHOR_EMAIL, 'sync@openchamber.invalid');
  assert.equal(commitTree.options.env.GIT_COMMITTER_DATE, '@1234567890 +0000');
  assert.deepEqual(commitTree.args.slice(commitTree.args.lastIndexOf('-c'), commitTree.args.lastIndexOf('-c') + 2), ['-c', 'commit.gpgsign=false']);

  const push = git.calls.find(({ args }) => args.includes('push'));
  assert.deepEqual(push.args.slice(-3), ['push', 'https://github.com/acme/config.git', 'refs/heads/main:refs/heads/main']);
  assert.deepEqual(push.args.slice(push.args.lastIndexOf('-c'), push.args.lastIndexOf('-c') + 2), ['-c', 'push.gpgSign=false']);
  assert.equal(git.calls.every(({ options }) => options.shell === false
    && options.timeout > 0 && options.timeout <= 10_000 && options.maxBuffer > 0
    && options.env.GIT_TERMINAL_PROMPT === '0'), true);
});

test('pushes ssh remotes with non-interactive batch-mode ssh', async () => {
  const git = fakeGit();
  await pushBootstrapState({
    url: 'git@github.com:acme/config.git',
    branch: 'main',
    path: statePath,
    content: '{}\n',
    execFile: git.execFile,
  });
  const push = git.calls.find(({ args }) => args.includes('push'));
  assert.equal(push.options.env.GIT_SSH_COMMAND.includes('BatchMode=yes'), true);
});

test('rejects invalid remotes, paths, branches, and oversized state before any Git command', async () => {
  for (const { request, code } of [
    { request: { url: 'https://user:secret@github.com/acme/config.git' }, code: 'INVALID_REPOSITORY_REMOTE' },
    { request: { url: 'https://example.com/acme/config.git' }, code: 'INVALID_REPOSITORY_REMOTE' },
    { request: { path: 'machines/../state.json' }, code: TypeError },
    { request: { path: 'machines/machine/state.json.bak' }, code: TypeError },
    { request: { path: 'other/machine/state.json' }, code: TypeError },
    { request: { branch: 'trunk' }, code: TypeError },
  ]) {
    const git = fakeGit();
    await assert.rejects(pushBootstrapState({
      url: 'https://github.com/acme/config.git',
      branch: 'main',
      path: statePath,
      content: '{}\n',
      execFile: git.execFile,
      ...request,
    }), (error) => {
      if (code === TypeError) return error instanceof TypeError;
      return error.code === code;
    });
    assert.equal(git.calls.length, 0);
  }

  const oversized = fakeGit();
  await assert.rejects(pushBootstrapState({
    url: 'https://github.com/acme/config.git',
    branch: 'main',
    path: statePath,
    content: 'x'.repeat(8 * 1024 * 1024 + 1),
    execFile: oversized.execFile,
  }), (error) => error.code === 'STATE_TOO_LARGE');
  assert.equal(oversized.calls.length, 0);
});

test('maps a non-fast-forward rejection to a safe repository-changed error', async () => {
  const git = fakeGit({
    onPush(callback) {
      callback(Object.assign(new Error('git failed'), { code: 1 }), Buffer.alloc(0),
        Buffer.from(" ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs to 'secret-host/private-detail'\n"));
    },
  });
  await assert.rejects(pushBootstrapState({
    url: 'https://github.com/acme/config.git', branch: 'main', path: statePath, content: '{}\n', execFile: git.execFile,
  }), (error) => {
    assert.equal(error.code, 'REPOSITORY_CHANGED');
    assert.doesNotMatch(error.message, /secret-host|rejected|non-fast/);
    return true;
  });
});

test('maps other push failures, timeouts, and missing git to safe errors', async () => {
  for (const { onPush, code } of [
    {
      onPush(callback) {
        callback(Object.assign(new Error('git failed'), { code: 128 }), Buffer.alloc(0),
          Buffer.from('error: The requested URL returned error: 403\nremote: private detail\n'));
      },
      code: 'GIT_PUSH_FAILED',
    },
    {
      onPush(callback) {
        callback(Object.assign(new Error('git failed'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), '', '');
      },
      code: 'GIT_PUSH_FAILED',
    },
    {
      onPush(callback) {
        callback(Object.assign(new Error('git failed'), { killed: true }), '', '');
      },
      code: 'GIT_TIMEOUT',
    },
  ]) {
    const git = fakeGit({ onPush });
    await assert.rejects(pushBootstrapState({
      url: 'https://github.com/acme/config.git', branch: 'main', path: statePath, content: '{}\n', execFile: git.execFile,
    }), (error) => {
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /403|private detail/);
      return true;
    });
  }

  await assert.rejects(pushBootstrapState({
    url: 'https://github.com/acme/config.git', branch: 'main', path: statePath, content: '{}\n',
    execFile(_file, _args, _options, callback) {
      callback(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }), '', '');
    },
  }), (error) => error.code === 'GIT_NOT_INSTALLED');
});

test('stops before starting another Git process after the total deadline', async () => {
  let calls = 0;
  let time = 0;
  await assert.rejects(pushBootstrapState({
    url: 'https://github.com/acme/config.git', branch: 'main', path: statePath, content: '{}\n',
    now: () => {
      const current = time;
      time += 50_000;
      return current;
    },
    execFile() { calls += 1; },
  }), (error) => error.code === 'GIT_TIMEOUT');
  assert.equal(calls, 0);
});

function localPushExec(bareRepository, recorded, onAfterCall) {
  return (file, args, options, callback) => {
    const rewritten = [...args];
    const pushIndex = rewritten.indexOf('push');
    if (pushIndex >= 0) rewritten[pushIndex + 1] = bareRepository;
    const lsRemoteIndex = rewritten.indexOf('ls-remote');
    if (lsRemoteIndex >= 0) rewritten[lsRemoteIndex + 1] = bareRepository;
    const originIndex = rewritten.indexOf('origin');
    if (originIndex >= 0 && rewritten[originIndex - 1] === 'add' && rewritten[originIndex - 2] === 'remote') {
      rewritten[originIndex + 1] = bareRepository;
    }
    recorded.push(rewritten);
    nodeExecFile(file, rewritten, options, callback);
    if (onAfterCall) onAfterCall(rewritten);
  };
}

function gitSync(bareRepository, ...args) {
  return execFileSync('git', ['-C', bareRepository, ...args], { encoding: 'buffer' });
}

test('pushes the initial machine state to an empty local bare repository', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'repository-push-'));
  const bare = path.join(root, 'remote.git');
  let temporaryDirectory;
  try {
    execFileSync('git', ['init', '--bare', '--initial-branch=main', '--quiet', bare], { stdio: 'ignore' });
    execFileSync('git', ['-C', bare, 'config', 'uploadpack.allowFilter', 'true'], { stdio: 'ignore' });
    const state = createMachineState({ machineId, values: { 'preferences.darkThemeId': 'dark' }, now: 42 });
    const recorded = [];
    const result = await pushBootstrapState({
      url: 'git@github.com:acme/config.git',
      branch: 'main',
      path: statePath,
      content: `${stableJson(state)}\n`,
      commitTimestamp: 42_000,
      execFile: localPushExec(bare, recorded),
    });
    const init = recorded.find((args) => args.includes('init'));
    temporaryDirectory = path.dirname(init.at(-1));

    const commit = result.commit;
    assert.match(commit, /^[a-f0-9]{40}$/);
    assert.equal(gitSync(bare, 'rev-parse', '--verify', 'refs/heads/main').toString().trim(), commit);
    const tree = gitSync(bare, 'ls-tree', '-r', '-z', commit).toString();
    assert.match(tree, new RegExp(`100644 blob [a-f0-9]{40}\\t${statePath}\\0`));
    assert.equal(tree.split('\0').filter(Boolean).length, 1);
    const blob = gitSync(bare, 'show', `${commit}:${statePath}`).toString();
    assert.equal(blob, `${stableJson(state)}\n`);
    const parents = gitSync(bare, 'rev-list', '--parents', '-n', '1', commit).toString().trim().split(' ');
    assert.equal(parents.length, 1);
    const identity = gitSync(bare, 'show', '-s', '--format=%an|%ae|%aI|%cI', commit).toString().trim().split('|');
    assert.deepEqual(identity, ['OpenChamber Sync', 'sync@openchamber.invalid', '1970-01-01T00:00:42+00:00', '1970-01-01T00:00:42+00:00']);

    await assert.rejects(lstat(temporaryDirectory), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('parents the bootstrap commit on an existing unrelated main and preserves its files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'repository-push-parent-'));
  const bare = path.join(root, 'remote.git');
  const scratch = path.join(root, 'scratch');
  try {
    execFileSync('git', ['init', '--bare', '--initial-branch=main', '--quiet', bare], { stdio: 'ignore' });
    execFileSync('git', ['-C', bare, 'config', 'uploadpack.allowFilter', 'true'], { stdio: 'ignore' });
    execFileSync('git', ['init', '--initial-branch=main', '--quiet', scratch], { stdio: 'ignore' });
    const git = (...args) => execFileSync('git', ['-C', scratch, ...args], { stdio: 'ignore' });
    await writeFile(path.join(scratch, 'README.md'), 'Unrelated repository introduction.\n');
    git('add', 'README.md');
    git('-c', 'user.name=Setup', '-c', 'user.email=setup@example.invalid', 'commit', '-m', 'unrelated start');
    git('push', '--quiet', bare, 'HEAD:main');

    const state = createMachineState({ machineId, values: { 'preferences.darkThemeId': 'dark' }, now: 42 });
    const result = await pushBootstrapState({
      url: 'git@github.com:acme/config.git',
      branch: 'main',
      path: statePath,
      content: `${stableJson(state)}\n`,
      commitTimestamp: 42_000,
      execFile: localPushExec(bare, []),
    });
    assert.equal(result.unchanged, false);

    const head = gitSync(bare, 'rev-parse', '--verify', 'refs/heads/main').toString().trim();
    assert.equal(head, result.commit);
    // The commit parents on the previous remote head: a fast-forward, no force.
    const parents = gitSync(bare, 'rev-list', '--parents', '-n', '1', head).toString().trim().split(' ');
    assert.equal(parents.length, 2);
    // Unrelated content survived; only the state file was added.
    const files = gitSync(bare, 'ls-tree', '-r', '--name-only', head).toString().trim().split('\n').sort();
    assert.deepEqual(files, ['README.md', `machines/${machineId}/state.json`]);
    const blob = gitSync(bare, 'show', `${head}:${statePath}`).toString();
    assert.equal(blob, `${stableJson(state)}\n`);

    // Repeating an already-pushed bootstrap is a no-op that reports the head.
    const repeat = await pushBootstrapState({
      url: 'git@github.com:acme/config.git',
      branch: 'main',
      path: statePath,
      content: `${stableJson(state)}\n`,
      commitTimestamp: 42_000,
      execFile: localPushExec(bare, []),
    });
    assert.deepEqual(repeat, { commit: head, branch: 'main', unchanged: true });
    assert.equal(gitSync(bare, 'rev-parse', '--verify', 'refs/heads/main').toString().trim(), head);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('leaves the remote unchanged when another machine pushed while we prepared', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'repository-push-race-'));
  const bare = path.join(root, 'remote.git');
  const scratch = path.join(root, 'scratch');
  try {
    execFileSync('git', ['init', '--bare', '--initial-branch=main', '--quiet', bare], { stdio: 'ignore' });
    execFileSync('git', ['-C', bare, 'config', 'uploadpack.allowFilter', 'true'], { stdio: 'ignore' });
    execFileSync('git', ['init', '--initial-branch=main', '--quiet', scratch], { stdio: 'ignore' });
    const git = (...args) => execFileSync('git', ['-C', scratch, ...args], { stdio: 'ignore' });
    git('commit', '--allow-empty', '-m', 'unrelated first commit');
    git('push', '--quiet', bare, 'HEAD:main');

    // Simulate a remote update that lands after our read of the remote head:
    // the extra commit arrives once the pusher has fetched, so its parent is
    // stale and the push must be rejected without force.
    let sawFetch = false;
    const execFile = localPushExec(bare, [], (args) => {
      if (!sawFetch && args.includes('fetch')) {
        sawFetch = true;
        git('commit', '--allow-empty', '-m', 'concurrent update');
        git('push', '--quiet', bare, 'HEAD:main');
      }
    });

    const state = createMachineState({ machineId, values: { 'preferences.darkThemeId': 'dark' }, now: 42 });
    await assert.rejects(pushBootstrapState({
      url: 'git@github.com:acme/config.git',
      branch: 'main',
      path: statePath,
      content: `${stableJson(state)}\n`,
      execFile,
    }), (error) => error.code === 'REPOSITORY_CHANGED');

    const concurrentHead = gitSync(scratch, 'rev-parse', 'HEAD').toString().trim();
    assert.equal(gitSync(bare, 'rev-parse', 'refs/heads/main').toString().trim(), concurrentHead);
    assert.equal(gitSync(bare, 'ls-tree', '-r', 'refs/heads/main').toString().includes(statePath), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('maps a push rejected by the remote to a safe failure without leaking output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'repository-push-fail-'));
  const bare = path.join(root, 'remote.git');
  try {
    execFileSync('git', ['init', '--bare', '--initial-branch=main', '--quiet', bare], { stdio: 'ignore' });
    execFileSync('git', ['-C', bare, 'config', 'uploadpack.allowFilter', 'true'], { stdio: 'ignore' });
    await writeFile(path.join(bare, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const state = createMachineState({ machineId, values: {}, now: 42 });
    await assert.rejects(pushBootstrapState({
      url: 'git@github.com:acme/config.git',
      branch: 'main',
      path: statePath,
      content: `${stableJson(state)}\n`,
      execFile: localPushExec(bare, []),
    }), (error) => {
      assert.equal(error.code, 'GIT_PUSH_FAILED');
      assert.equal(error.message, 'Git could not update the target remote');
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reuses one deterministic commit for identical content and accepts a repeated push', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'repository-push-idem-'));
  const first = path.join(root, 'first.git');
  const second = path.join(root, 'second.git');
  try {
    execFileSync('git', ['init', '--bare', '--initial-branch=main', '--quiet', first], { stdio: 'ignore' });
    execFileSync('git', ['init', '--bare', '--initial-branch=main', '--quiet', second], { stdio: 'ignore' });
    execFileSync('git', ['-C', first, 'config', 'uploadpack.allowFilter', 'true'], { stdio: 'ignore' });
    const state = createMachineState({ machineId, values: { 'preferences.darkThemeId': 'dark' }, now: 42 });
    const request = {
      url: 'git@github.com:acme/config.git',
      branch: 'main',
      path: statePath,
      content: `${stableJson(state)}\n`,
      commitTimestamp: 42_000,
    };
    const firstResult = await pushBootstrapState({ ...request, execFile: localPushExec(first, []) });
    const secondResult = await pushBootstrapState({ ...request, execFile: localPushExec(second, []) });
    assert.equal(firstResult.commit, secondResult.commit);

    const repeat = await pushBootstrapState({ ...request, execFile: localPushExec(first, []) });
    assert.equal(repeat.commit, firstResult.commit);
    assert.equal(gitSync(first, 'rev-parse', 'refs/heads/main').toString().trim(), firstResult.commit);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
