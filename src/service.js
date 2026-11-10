import http from 'node:http';

import { createLocalPreview } from './local-preview.js';
import { probeGitHubRepo } from './repository.js';

const MAX_REQUEST_BYTES = 4096;

function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw Object.assign(new Error(), { code: 'BODY_TOO_LARGE' });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function isRequestObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function createServiceServer({ token, openChamberDir, openCodeDir, gitProbe = probeGitHubRepo }) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new TypeError('A service token is required');
  }

  return http.createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      sendJson(response, 401, { error: 'unauthorized' });
      return;
    }

    let pathname;
    try {
      pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      sendJson(response, 400, { error: 'bad-request' });
      return;
    }
    if (request.method === 'GET' && pathname === '/health') {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === 'GET' && pathname === '/preview') {
      try {
        sendJson(response, 200, await createLocalPreview({ openChamberDir, openCodeDir }));
      } catch {
        sendJson(response, 503, { error: 'preview-unavailable' });
      }
      return;
    }
    if (request.method === 'POST' && pathname === '/repository/test') {
      let body;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        sendJson(response, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: 'invalid-request' });
        return;
      }
      if (!isRequestObject(body) || Object.keys(body).some((key) => key !== 'url')
        || typeof body.url !== 'string') {
        sendJson(response, 400, { error: 'invalid-request' });
        return;
      }
      try {
        const result = await gitProbe(body.url);
        sendJson(response, 200, { accessible: true, repository: result.repository, url: result.url });
      } catch (error) {
        const code = error?.code;
        const status = code === 'INVALID_REPOSITORY_URL' ? 400
          : code === 'GIT_NOT_INSTALLED' ? 503
            : code === 'GIT_TIMEOUT' ? 504 : 422;
        const publicCode = code === 'INVALID_REPOSITORY_URL' ? 'invalid-repository-url'
          : code === 'GIT_NOT_INSTALLED' ? 'git-not-installed'
            : code === 'GIT_TIMEOUT' ? 'git-timeout' : 'git-access-failed';
        sendJson(response, status, { error: publicCode });
      }
      return;
    }
    sendJson(response, 404, { error: 'not-found' });
  });
}
