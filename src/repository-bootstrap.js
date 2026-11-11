import { createMachineState, isValidMachineId, stableJson } from './state.js';

const REQUIRED_SOURCES = ['preferences', 'opencode', 'opencode-files', 'extensions'];

function bootstrapError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function createRepositoryBootstrapState({ machineId, local, remote, now = Date.now() }) {
  if (!isValidMachineId(machineId)) throw new TypeError('Invalid machine id');
  if (!remote || typeof remote.empty !== 'boolean' || !Array.isArray(remote.states)) {
    throw bootstrapError('REPOSITORY_NOT_EMPTY', 'Repository bootstrap requires an empty repository');
  }
  // A repository without machine state is safe to bootstrap even when its
  // default branch carries unrelated content (a README, a probe commit):
  // there is no sync data to overwrite, and the push parents on the remote
  // head so unrelated files are preserved.
  if (remote.states.length !== 0) {
    throw bootstrapError('REPOSITORY_NOT_EMPTY', 'Repository bootstrap requires a repository without machine state');
  }
  if (!local || !local.sources || !local.values
    || REQUIRED_SOURCES.some((source) => local.sources[source]?.status !== 'ready')) {
    throw bootstrapError('LOCAL_SOURCES_UNAVAILABLE', 'All portable local sources must be ready before bootstrap');
  }

  const state = createMachineState({ machineId, values: local.values, now });
  const content = `${JSON.stringify(JSON.parse(stableJson(state)), null, 2)}\n`;
  return {
    branch: 'main',
    path: `machines/${machineId}/state.json`,
    state,
    content,
  };
}
