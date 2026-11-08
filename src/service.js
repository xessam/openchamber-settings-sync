import http from 'node:http';

import { createLocalPreview } from './local-preview.js';

function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

export function createServiceServer({ token, openChamberDir, openCodeDir }) {
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
    sendJson(response, 404, { error: 'not-found' });
  });
}
