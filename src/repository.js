import { execFile as nodeExecFile } from 'node:child_process';

function repositoryError(code) {
  const message = code === 'INVALID_REPOSITORY_URL' ? 'Invalid GitHub repository URL' : 'Git repository access failed';
  return Object.assign(new Error(message), { code });
}

export function normalizeGitHubRepoUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) {
    throw repositoryError('INVALID_REPOSITORY_URL');
  }

  const input = value.trim();
  const authority = input.match(/^https:\/\/([^/?#]*)/i)?.[1];
  if (!authority || authority.includes('@')) throw repositoryError('INVALID_REPOSITORY_URL');

  let url;
  try {
    url = new URL(input);
  } catch {
    throw repositoryError('INVALID_REPOSITORY_URL');
  }

  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port
    || url.username || url.password || url.search || url.hash) {
    throw repositoryError('INVALID_REPOSITORY_URL');
  }

  const match = url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (!match || match[1] === '.' || match[1] === '..' || match[2] === '.' || match[2] === '..') {
    throw repositoryError('INVALID_REPOSITORY_URL');
  }

  const owner = match[1];
  const name = match[2];
  if (!name || name.endsWith('.git')) throw repositoryError('INVALID_REPOSITORY_URL');
  return {
    url: `https://github.com/${owner}/${name}.git`,
    repository: `${owner}/${name}`,
  };
}

export function probeGitHubRepo(value, { execFile = nodeExecFile } = {}) {
  let remote;
  try {
    remote = normalizeGitHubRepoUrl(value);
  } catch {
    return Promise.reject(repositoryError('INVALID_REPOSITORY_URL'));
  }

  return new Promise((resolve, reject) => {
    execFile('git', ['ls-remote', '--heads', remote.url], {
      shell: false,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
      },
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
