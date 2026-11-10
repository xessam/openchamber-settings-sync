import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeGitHubRemote, probeGitHubRepo } from '../src/repository.js';

test('normalizes a credential-free GitHub repository URL', () => {
  assert.deepEqual(normalizeGitHubRemote(' https://github.com/acme/config.git/ '), {
    url: 'https://github.com/acme/config.git',
    repository: 'acme/config',
    transport: 'https',
  });
});

test('accepts GitHub scp-style SSH remotes', () => {
  assert.deepEqual(normalizeGitHubRemote('git@github.com:xessam/openchamber-sync.git'), {
    url: 'git@github.com:xessam/openchamber-sync.git',
    repository: 'xessam/openchamber-sync',
    transport: 'ssh',
  });
});

test('rejects URLs that could embed credentials or target a different host', () => {
  for (const url of [
    'http://github.com/acme/config',
    'https://user:token@github.com/acme/config',
    'https://github.com/acme/config?token=secret',
    'https://github.com/acme/config#main',
    'https://example.com/acme/config',
    'https://github.com/acme/config/extra',
  ]) {
    assert.throws(() => normalizeGitHubRemote(url), /GitHub repository remote/i, url);
  }
});

test('rejects SSH remotes with unexpected users, hosts, or path components', () => {
  for (const remote of [
    'alice@github.com:acme/config.git',
    'git@evil.example:acme/config.git',
    'git@github.com:acme/config/extra.git',
    'git@github.com:acme/../config.git',
    'ssh://git@github.com/acme/config.git',
  ]) {
    assert.throws(() => normalizeGitHubRemote(remote), /GitHub repository remote/i, remote);
  }
});

test('probes with non-interactive git and never places credentials in arguments', async () => {
  let invocation;
  const result = await probeGitHubRepo('https://github.com/acme/config.git', {
    execFile(file, args, options, callback) {
      invocation = { file, args, options };
      callback(null, 'main-ref output is intentionally ignored', '');
    },
  });

  assert.deepEqual(result, { url: 'https://github.com/acme/config.git', repository: 'acme/config', transport: 'https' });
  assert.equal(invocation.file, 'git');
  assert.deepEqual(invocation.args, ['ls-remote', '--heads', 'https://github.com/acme/config.git']);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(invocation.options.env.GCM_INTERACTIVE, 'never');
  assert.equal(invocation.options.timeout, 7_000);
  assert.equal(invocation.options.env.GIT_SSH_COMMAND, undefined);
});

test('uses non-interactive OpenSSH for a validated SSH remote', async () => {
  let invocation;
  const result = await probeGitHubRepo('git@github.com:xessam/openchamber-sync.git', {
    execFile(file, args, options, callback) {
      invocation = { file, args, options };
      callback(null, '', '');
    },
  });

  assert.deepEqual(result, {
    url: 'git@github.com:xessam/openchamber-sync.git',
    repository: 'xessam/openchamber-sync',
    transport: 'ssh',
  });
  assert.equal(invocation.file, 'git');
  assert.deepEqual(invocation.args, ['ls-remote', '--heads', 'git@github.com:xessam/openchamber-sync.git']);
  assert.equal(invocation.options.env.GIT_SSH_COMMAND, 'ssh -o BatchMode=yes -o ConnectTimeout=5');
  assert.equal(invocation.options.env.GIT_TERMINAL_PROMPT, '0');
});

test('returns a generic access error instead of exposing git stderr', async () => {
  await assert.rejects(
    probeGitHubRepo('https://github.com/acme/config.git', {
      execFile(_file, _args, _options, callback) {
        const error = Object.assign(new Error('failed'), { code: 128 });
        callback(error, '', 'remote: private details');
      },
    }),
    (error) => error.code === 'GIT_ACCESS_FAILED' && !error.message.includes('private details'),
  );
});
