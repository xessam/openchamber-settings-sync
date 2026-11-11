import { execFile as nodeExecFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { mergeMachineStates } from './state.js';
import { normalizeGitHubRemote } from './repository.js';

const MAX_REF_OUTPUT_BYTES = 1024 * 1024;
const MAX_TREE_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_STATE_BYTES = 32 * 1024 * 1024;
const MAX_MACHINE_STATES = 64;
const MAX_ENTRIES_PER_STATE = 4096;
const MAX_TOTAL_STATE_ENTRIES = 16_384;
const MAX_OPERATION_MS = 15_000;
const MAX_COMMAND_MS = 10_000;
const SAFE_REMOTE_ERRORS = new WeakSet();

function remoteStateError(code) {
  const messages = {
    INVALID_REPOSITORY_REMOTE: 'Invalid GitHub repository remote',
    GIT_TIMEOUT: 'Git repository operation timed out',
    GIT_NOT_INSTALLED: 'Git is not available',
    REMOTE_FILTER_UNSUPPORTED: 'Remote Git server does not support bounded blob filtering',
    REMOTE_STATE_TOO_LARGE: 'Remote repository state exceeds the supported size limit',
    REMOTE_STATE_INVALID: 'Remote repository state is invalid',
  };
  const error = Object.assign(new Error(messages[code] ?? 'Git repository access failed'), { code });
  SAFE_REMOTE_ERRORS.add(error);
  return error;
}

function outputBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  return Buffer.alloc(0);
}

function utf8Text(value) {
  const text = value.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(value)) throw remoteStateError('REMOTE_STATE_INVALID');
  return text;
}

function parseMachineTree(output) {
  if (output.length > MAX_TREE_OUTPUT_BYTES) throw remoteStateError('REMOTE_STATE_TOO_LARGE');
  if (output.length === 0) return [];
  if (output[output.length - 1] !== 0) throw remoteStateError('REMOTE_STATE_INVALID');

  const states = [];
  const machineIds = new Set();
  let start = 0;
  while (start < output.length) {
    const end = output.indexOf(0, start);
    if (end < 0) throw remoteStateError('REMOTE_STATE_INVALID');
    const record = output.subarray(start, end);
    const tab = record.indexOf(9);
    if (tab < 0) throw remoteStateError('REMOTE_STATE_INVALID');
    const metadata = record.subarray(0, tab).toString('ascii').split(' ');
    const relativePathBytes = record.subarray(tab + 1);
    const relativePath = utf8Text(relativePathBytes);
    const match = relativePath.match(/^machines\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/state\.json$/);
    if (metadata.length !== 3 || metadata[0] !== '100644' || metadata[1] !== 'blob'
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(metadata[2]) || !match
      || machineIds.has(match[1])) {
      throw remoteStateError('REMOTE_STATE_INVALID');
    }
    machineIds.add(match[1]);
    states.push({ machineId: match[1], relativePath });
    if (states.length > MAX_MACHINE_STATES) throw remoteStateError('REMOTE_STATE_TOO_LARGE');
    start = end + 1;
  }
  return states;
}

function parseMachineState(output, expectedMachineId) {
  const text = utf8Text(output);
  let state;
  try {
    state = JSON.parse(text);
    if (!state || typeof state !== 'object' || Array.isArray(state)
      || state.machineId !== expectedMachineId) throw new TypeError('Invalid machine state');
    if (!state.entries || typeof state.entries !== 'object' || Array.isArray(state.entries)) {
      throw new TypeError('Invalid machine state entries');
    }
    if (Object.keys(state.entries).length > MAX_ENTRIES_PER_STATE) {
      throw remoteStateError('REMOTE_STATE_TOO_LARGE');
    }
    mergeMachineStates([state]);
  } catch (error) {
    if (error && SAFE_REMOTE_ERRORS.has(error)) throw error;
    throw remoteStateError('REMOTE_STATE_INVALID');
  }
  return state;
}

function countStateEntries(states) {
  const total = states.reduce((count, state) => count + Object.keys(state.entries).length, 0);
  if (total > MAX_TOTAL_STATE_ENTRIES) throw remoteStateError('REMOTE_STATE_TOO_LARGE');
}

export async function readRemoteMachineStates(value, {
  execFile = nodeExecFile,
  now = () => performance.now(),
} = {}) {
  let remote;
  try {
    remote = normalizeGitHubRemote(value);
  } catch {
    throw remoteStateError('INVALID_REPOSITORY_REMOTE');
  }

  const startedAt = now();
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_OPTIONAL_LOCKS: '0',
  };
  if (remote.transport === 'ssh') {
    env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o ConnectTimeout=5';
  }

  const runGit = (args, { maxBuffer, tooLargeCode = 'REMOTE_STATE_TOO_LARGE' } = {}) => new Promise((resolve, reject) => {
    const remaining = MAX_OPERATION_MS - (now() - startedAt);
    if (remaining <= 0) {
      reject(remoteStateError('GIT_TIMEOUT'));
      return;
    }
    execFile('git', args, {
      shell: false,
      encoding: 'buffer',
      timeout: Math.max(1, Math.min(MAX_COMMAND_MS, remaining)),
      maxBuffer,
      env,
    }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ stdout: outputBuffer(stdout), stderr: outputBuffer(stderr) });
        return;
      }
      if (error.code === 'ENOENT') reject(remoteStateError('GIT_NOT_INSTALLED'));
      else if (error.killed || error.code === 'ETIMEDOUT') reject(remoteStateError('GIT_TIMEOUT'));
      else if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') reject(remoteStateError(tooLargeCode));
      else reject(remoteStateError('GIT_ACCESS_FAILED'));
    });
  });

  const refs = await runGit(['ls-remote', '--heads', remote.url], { maxBuffer: MAX_REF_OUTPUT_BYTES });
  if (refs.stdout.length === 0) return { empty: true, states: [] };

  let temporaryDirectory;
  try {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'openchamber-sync-read-'));
    const repositoryDirectory = path.join(temporaryDirectory, 'repository');
    const templateDirectory = path.join(temporaryDirectory, 'template');
    const hooksDirectory = path.join(temporaryDirectory, 'hooks');
    await Promise.all([mkdir(templateDirectory), mkdir(hooksDirectory)]);

    const gitConfig = ['-c', `core.hooksPath=${hooksDirectory}`, '-c', 'core.fsmonitor=false', '-c', 'fetch.fsckObjects=true'];
    await runGit([...gitConfig, 'init', '--bare', '--quiet', `--template=${templateDirectory}`, repositoryDirectory], {
      maxBuffer: 256 * 1024,
    });
    const localGit = (args, options) => runGit(['-C', repositoryDirectory, ...gitConfig, ...args], options);
    await localGit(['remote', 'add', 'origin', remote.url], { maxBuffer: 256 * 1024 });
    await localGit(['config', 'extensions.partialClone', 'origin'], { maxBuffer: 256 * 1024 });
    await localGit(['config', 'remote.origin.promisor', 'true'], { maxBuffer: 256 * 1024 });
    await localGit(['config', 'remote.origin.partialclonefilter', 'blob:none'], { maxBuffer: 256 * 1024 });
    const fetch = await localGit(['fetch', '--filter=blob:none', '--depth=1', '--no-tags', '--no-recurse-submodules', 'origin', 'HEAD'], {
      maxBuffer: 1024 * 1024,
    });
    if (/filtering not recognized by server|filter(?:ing)?[^\n]*not supported/i.test(fetch.stderr.toString('utf8'))) {
      throw remoteStateError('REMOTE_FILTER_UNSUPPORTED');
    }
    const head = await localGit(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], { maxBuffer: 4096 });
    const commit = utf8Text(head.stdout).trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit)) throw remoteStateError('REMOTE_STATE_INVALID');

    const tree = await localGit(['ls-tree', '-r', '-z', '--full-tree', commit, '--', 'machines'], {
      maxBuffer: MAX_TREE_OUTPUT_BYTES,
    });
    const machineFiles = parseMachineTree(tree.stdout);
    const states = [];
    let totalBytes = 0;
    for (const file of machineFiles) {
      const remainingBytes = MAX_TOTAL_STATE_BYTES - totalBytes;
      if (remainingBytes <= 0) throw remoteStateError('REMOTE_STATE_TOO_LARGE');
      const outputLimit = Math.min(MAX_STATE_BYTES, remainingBytes) + 1;
      const blob = await localGit(['show', '--no-ext-diff', '--no-textconv', `${commit}:${file.relativePath}`], {
        maxBuffer: outputLimit,
      });
      totalBytes += blob.stdout.length;
      if (blob.stdout.length > MAX_STATE_BYTES || totalBytes > MAX_TOTAL_STATE_BYTES) {
        throw remoteStateError('REMOTE_STATE_TOO_LARGE');
      }
      states.push(parseMachineState(blob.stdout, file.machineId));
      countStateEntries(states);
    }
    return { empty: false, states };
  } catch (error) {
    if (error && SAFE_REMOTE_ERRORS.has(error)) throw error;
    throw remoteStateError('GIT_ACCESS_FAILED');
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
  }
}
