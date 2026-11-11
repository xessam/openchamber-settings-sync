import { execFile as nodeExecFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { normalizeGitHubRemote } from './repository.js';

const MAX_OPERATION_MS = 15_000;
const MAX_COMMAND_MS = 10_000;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_PUSH_OUTPUT_BYTES = 1024 * 1024;
const STATE_PATH_PATTERN = /^machines\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/state\.json$/;
const COMMIT_MESSAGE = 'OpenChamber Sync: initial machine state';
const COMMIT_NAME = 'OpenChamber Sync';
const COMMIT_EMAIL = 'sync@openchamber.invalid';
const NON_FAST_FORWARD_PATTERN = /\[\s*rejected\]|non-fast-forward|fetch first/i;
const FILTER_UNSUPPORTED_PATTERN = /filtering not recognized by server|filter(?:ing)?[^\n]*not supported/i;
const SAFE_PUSH_ERRORS = new WeakSet();

function pushError(code) {
  const messages = {
    INVALID_REPOSITORY_REMOTE: 'Invalid GitHub repository remote',
    GIT_NOT_INSTALLED: 'Git is not available',
    GIT_TIMEOUT: 'Git repository operation timed out',
    REPOSITORY_CHANGED: 'The remote moved while the initial state was being pushed. Refresh the comparison and confirm again.',
    GIT_PUSH_FAILED: 'Git could not update the target remote',
    REMOTE_FILTER_UNSUPPORTED: 'The repository server could not provide bounded state data',
    STATE_TOO_LARGE: 'The machine state exceeds the supported size limit',
  };
  const error = Object.assign(new Error(messages[code] ?? 'Git repository push failed'), { code });
  SAFE_PUSH_ERRORS.add(error);
  return error;
}

function shaText(output) {
  const value = output.toString('utf8').trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)) throw pushError('GIT_PUSH_FAILED');
  return value;
}

// `git ls-remote <url> refs/heads/main` prints "<sha>\trefs/heads/main" when
// the branch exists and nothing at all for an empty repository.
function headShaFromLsRemote(output) {
  const text = output.toString('utf8').trim();
  if (text === '') return null;
  const sha = text.split('\t')[0]?.trim() ?? '';
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha)) throw pushError('GIT_ACCESS_FAILED');
  return sha;
}

function existingBlobShaFromLsTree(output, statePath) {
  const text = output.toString('utf8');
  for (const record of text.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) throw pushError('GIT_ACCESS_FAILED');
    const metadata = record.slice(0, tab).split(' ');
    if (metadata.length !== 3 || metadata[0] !== '100644' || metadata[1] !== 'blob'
      || record.slice(tab + 1) !== statePath) {
      throw pushError('GIT_ACCESS_FAILED');
    }
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(metadata[2])) throw pushError('GIT_ACCESS_FAILED');
    return metadata[2];
  }
  return null;
}

export async function pushBootstrapState({
  url,
  branch = 'main',
  path: statePath,
  content,
  commitTimestamp = Date.now(),
  execFile = nodeExecFile,
  now = () => performance.now(),
}) {
  let remote;
  try {
    remote = normalizeGitHubRemote(url);
  } catch {
    throw pushError('INVALID_REPOSITORY_REMOTE');
  }
  if (branch !== 'main') throw new TypeError('Bootstrap pushes only to the main branch');
  if (typeof statePath !== 'string' || !STATE_PATH_PATTERN.test(statePath)) {
    throw new TypeError('Invalid initial state path');
  }
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_STATE_BYTES) {
    throw pushError('STATE_TOO_LARGE');
  }
  if (!Number.isSafeInteger(commitTimestamp) || commitTimestamp < 0) {
    throw new TypeError('Invalid commit timestamp');
  }

  const startedAt = now();
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_OPTIONAL_LOCKS: '0',
  };
  if (remote.transport === 'ssh') {
    env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o ConnectTimeout=5';
  }

  const runGit = (args, { maxBuffer = 256 * 1024, extraEnv } = {}) => new Promise((resolve, reject) => {
    const remaining = MAX_OPERATION_MS - (now() - startedAt);
    if (remaining <= 0) {
      reject(pushError('GIT_TIMEOUT'));
      return;
    }
    execFile('git', args, {
      shell: false,
      encoding: 'buffer',
      timeout: Math.max(1, Math.min(MAX_COMMAND_MS, remaining)),
      maxBuffer,
      env: extraEnv ? { ...env, ...extraEnv } : env,
    }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ stdout, stderr });
        return;
      }
      if (error.code === 'ENOENT') reject(pushError('GIT_NOT_INSTALLED'));
      else if (error.killed || error.code === 'ETIMEDOUT') reject(pushError('GIT_TIMEOUT'));
      else if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') reject(pushError('GIT_PUSH_FAILED'));
      else {
        reject(Object.assign(new Error('Git repository push failed'), {
          code: 'GIT_ACCESS_FAILED',
          stderrText: stderr?.toString('utf8').slice(0, 4096) ?? '',
        }));
      }
    });
  });

  let temporaryDirectory;
  try {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'openchamber-sync-push-'));
    const repositoryDirectory = path.join(temporaryDirectory, 'repository');
    const templateDirectory = path.join(temporaryDirectory, 'template');
    const hooksDirectory = path.join(temporaryDirectory, 'hooks');
    const indexFile = path.join(temporaryDirectory, 'index');
    const contentFile = path.join(temporaryDirectory, 'state.json');
    await Promise.all([mkdir(templateDirectory), mkdir(hooksDirectory)]);
    await writeFile(contentFile, content, { mode: 0o600 });

    const gitConfig = ['-c', `core.hooksPath=${hooksDirectory}`, '-c', 'core.fsmonitor=false', '-c', 'fetch.fsckObjects=true'];
    await runGit([...gitConfig, 'init', '--bare', '--quiet', `--template=${templateDirectory}`, repositoryDirectory]);
    const localGit = (args, options) => runGit(['-C', repositoryDirectory, ...gitConfig, ...args], options);

    // Read phase: discover whether the remote already has a main branch. A
    // repository whose main carries only unrelated content (README, notes) is
    // still safe to bootstrap: there is no machine state to overwrite, and the
    // commit below parents on the remote head so unrelated files survive.
    let parentSha = null;
    let baseTreeSha = null;
    try {
      const refs = await runGit(['ls-remote', remote.url, 'refs/heads/main'], { maxBuffer: 4096 });
      parentSha = headShaFromLsRemote(refs.stdout);
      if (parentSha) {
        await localGit(['remote', 'add', 'origin', remote.url], { maxBuffer: 4096 });
        await localGit(['config', 'extensions.partialClone', 'origin'], { maxBuffer: 4096 });
        await localGit(['config', 'remote.origin.promisor', 'true'], { maxBuffer: 4096 });
        await localGit(['config', 'remote.origin.partialclonefilter', 'blob:none'], { maxBuffer: 4096 });
        const fetch = await localGit(['fetch', '--filter=blob:none', '--depth=1', '--no-tags', '--no-recurse-submodules', 'origin', 'refs/heads/main'], {
          maxBuffer: 1024 * 1024,
        });
        if (FILTER_UNSUPPORTED_PATTERN.test(fetch.stderr.toString('utf8'))) {
          throw pushError('REMOTE_FILTER_UNSUPPORTED');
        }
        const commit = await localGit(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], { maxBuffer: 4096 });
        parentSha = shaText(commit.stdout);
        const tree = await localGit(['rev-parse', '--verify', `${parentSha}^{tree}`], { maxBuffer: 4096 });
        baseTreeSha = shaText(tree.stdout);
      }
    } catch (error) {
      if (error && SAFE_PUSH_ERRORS.has(error)) throw error;
      throw pushError('GIT_ACCESS_FAILED');
    }

    const hash = await localGit(['hash-object', '-w', '--', contentFile], { maxBuffer: 4096 });
    const blobSha = shaText(hash.stdout);

    // Idempotency: if the remote head already holds exactly this state, the
    // push is already done and repeating it changes nothing.
    if (parentSha) {
      const existing = await localGit(['ls-tree', '-z', parentSha, '--', statePath], { maxBuffer: 4096 });
      if (existingBlobShaFromLsTree(existing.stdout, statePath) === blobSha) {
        return { commit: parentSha, branch, unchanged: true };
      }
    }

    if (parentSha) {
      await localGit(['read-tree', baseTreeSha], { maxBuffer: 4096, extraEnv: { GIT_INDEX_FILE: indexFile } });
    }
    await localGit(['update-index', '--add', '--cacheinfo', '100644', blobSha, statePath], {
      extraEnv: { GIT_INDEX_FILE: indexFile },
    });
    const tree = await localGit(['write-tree'], { maxBuffer: 4096, extraEnv: { GIT_INDEX_FILE: indexFile } });
    const treeSha = shaText(tree.stdout);

    const commitSeconds = Math.floor(commitTimestamp / 1000);
    const commitDate = `@${commitSeconds} +0000`;
    const commit = await localGit([
      '-c', 'commit.gpgsign=false',
      'commit-tree', treeSha,
      ...(parentSha ? ['-p', parentSha] : []),
      '-m', COMMIT_MESSAGE,
    ], {
      maxBuffer: 4096,
      extraEnv: {
        GIT_AUTHOR_NAME: COMMIT_NAME,
        GIT_AUTHOR_EMAIL: COMMIT_EMAIL,
        GIT_COMMITTER_NAME: COMMIT_NAME,
        GIT_COMMITTER_EMAIL: COMMIT_EMAIL,
        GIT_AUTHOR_DATE: commitDate,
        GIT_COMMITTER_DATE: commitDate,
      },
    });
    const commitSha = shaText(commit.stdout);
    await localGit(['update-ref', `refs/heads/${branch}`, commitSha]);

    try {
      await localGit(['-c', 'push.gpgSign=false', 'push', remote.url, `refs/heads/${branch}:refs/heads/${branch}`], {
        maxBuffer: MAX_PUSH_OUTPUT_BYTES,
      });
    } catch (error) {
      if (error?.code === 'GIT_ACCESS_FAILED'
        && NON_FAST_FORWARD_PATTERN.test(error.stderrText ?? '')) {
        throw pushError('REPOSITORY_CHANGED');
      }
      throw error;
    }
    return { commit: commitSha, branch, unchanged: false };
  } catch (error) {
    if (error && SAFE_PUSH_ERRORS.has(error)) throw error;
    if (error?.code === 'GIT_ACCESS_FAILED') {
      if (NON_FAST_FORWARD_PATTERN.test(error.stderrText ?? '')) throw pushError('REPOSITORY_CHANGED');
      throw pushError('GIT_PUSH_FAILED');
    }
    throw pushError('GIT_PUSH_FAILED');
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
  }
}
