import test from 'node:test';
import assert from 'node:assert/strict';

import { probeGitHubRepo } from '../src/repository.js';
import { formatRepositoryDiagnostics } from '../src/repository-diagnostics.js';

const remote = 'git@github.com:acme/config.git';

async function failingProbe(stderr, error = Object.assign(new Error('private error'), { code: 128 })) {
  try {
    await probeGitHubRepo(remote, {
      execFile(_file, _args, _options, callback) { callback(error, '', stderr); },
    });
    assert.fail('Expected the probe to fail');
  } catch (caught) {
    return caught;
  }
}

test('classifies SSH failures without exposing raw stderr', async () => {
  for (const [stderr, reason] of [
    ['git@github.com: Permission denied (publickey). secret-token', 'ssh-authentication'],
    ['Host key verification failed. secret-token', 'ssh-host-key'],
    ['ssh: Could not resolve hostname github.com: secret-token', 'dns'],
    ['ssh: connect to host github.com port 22: Connection refused secret-token', 'connection'],
    ['ERROR: Repository not found. secret-token', 'repository-not-found'],
    ['unexpected credential helper output secret-token', 'unknown'],
  ]) {
    const error = await failingProbe(stderr);
    assert.equal(error.code, 'GIT_ACCESS_FAILED');
    assert.equal(error.diagnostics.reason, reason);
    assert.equal(error.diagnostics.exitCode, 128);
    assert.equal(error.diagnostics.transport, 'ssh');
    assert.doesNotMatch(JSON.stringify(error), /secret-token|private error/);
  }
});

test('reports timeout and agent availability without disclosing the socket path', async () => {
  const error = await failingProbe('secret-token', Object.assign(new Error('private'), { killed: true }));
  assert.equal(error.code, 'GIT_TIMEOUT');
  assert.equal(error.diagnostics.reason, 'timeout');
  assert.ok(['configured', 'not-configured'].includes(error.diagnostics.sshAgent));
  assert.doesNotMatch(JSON.stringify(error.diagnostics), /secret-token|private/);
});

test('formats a terminal-style log from recognized diagnostics only', () => {
  const lines = formatRepositoryDiagnostics({
    transport: 'ssh', sshAgent: 'not-configured', reason: 'ssh-authentication', exitCode: 128,
    unexpected: 'secret-token',
  });
  assert.match(lines.join('\n'), /git ls-remote --heads/);
  assert.match(lines.join('\n'), /SSH agent.*not configured/i);
  assert.match(lines.join('\n'), /public key/i);
  assert.match(lines.join('\n'), /128/);
  assert.doesNotMatch(lines.join('\n'), /secret-token/);
});
