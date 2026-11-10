import { execFile as nodeExecFile } from 'node:child_process';

function repositoryError(code) {
  const message = code === 'INVALID_REPOSITORY_REMOTE' ? 'Invalid GitHub repository remote' : 'Git repository access failed';
  return Object.assign(new Error(message), { code });
}

export function normalizeGitHubRemote(value) {
  if (typeof value !== 'string' || value.length > 2048) {
    throw repositoryError('INVALID_REPOSITORY_REMOTE');
  }

  const input = value.trim();
  const sshMatch = input.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (sshMatch) {
    const owner = sshMatch[1];
    const name = sshMatch[2];
    if (!name || [owner, name].some((part) => part === '.' || part === '..' || part.endsWith('.git'))) {
      throw repositoryError('INVALID_REPOSITORY_REMOTE');
    }
    return {
      url: `git@github.com:${owner}/${name}.git`,
      repository: `${owner}/${name}`,
      transport: 'ssh',
    };
  }

  const authority = input.match(/^https:\/\/([^/?#]*)/i)?.[1];
  if (!authority || authority.includes('@')) throw repositoryError('INVALID_REPOSITORY_REMOTE');

  let url;
  try {
    url = new URL(input);
  } catch {
    throw repositoryError('INVALID_REPOSITORY_REMOTE');
  }

  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port
    || url.username || url.password || url.search || url.hash) {
    throw repositoryError('INVALID_REPOSITORY_REMOTE');
  }

  const match = url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (!match || match[1] === '.' || match[1] === '..' || match[2] === '.' || match[2] === '..') {
    throw repositoryError('INVALID_REPOSITORY_REMOTE');
  }

  const owner = match[1];
  const name = match[2];
  if (!name || name.endsWith('.git')) throw repositoryError('INVALID_REPOSITORY_REMOTE');
  return {
    url: `https://github.com/${owner}/${name}.git`,
    repository: `${owner}/${name}`,
    transport: 'https',
  };
}

export function probeGitHubRepo(value, { execFile = nodeExecFile } = {}) {
  let remote;
  try {
    remote = normalizeGitHubRemote(value);
  } catch {
    return Promise.reject(repositoryError('INVALID_REPOSITORY_REMOTE'));
  }

  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
    };
    if (remote.transport === 'ssh') {
      env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o ConnectTimeout=5';
    }
    execFile('git', ['ls-remote', '--heads', remote.url], {
      shell: false,
      timeout: 7_000,
      maxBuffer: 1024 * 1024,
      env,
    }, (error) => {
      if (!error) {
        resolve(remote);
        return;
      }

      const code = error.code === 'ENOENT'
        ? 'GIT_NOT_INSTALLED'
        : error.killed || error.code === 'ETIMEDOUT'
          ? 'GIT_TIMEOUT'
          : 'GIT_ACCESS_FAILED';
      reject(repositoryError(code));
    });
  });
}
