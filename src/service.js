import http from 'node:http';
import { createHash, createHmac, randomBytes } from 'node:crypto';

import { planApplyChanges } from './apply-plan.js';
import { createBootstrapPreview } from './bootstrap-preview.js';
import { createLocalPreview } from './local-preview.js';
import { applyPlanToFiles, defaultApplyJournalPath } from './local-apply.js';
import { readLocalSnapshot } from './local-snapshot.js';
import { normalizeGitHubRemote, probeGitHubRepo } from './repository.js';
import { pushBootstrapState } from './repository-push.js';
import { sanitizeRepositoryDiagnostics } from './repository-diagnostics.js';
import { readRemoteMachineStates } from './remote-state.js';
import { isValidMachineId, mergeMachineStates, stableJson } from './state.js';
import { createRepositoryBootstrapState } from './repository-bootstrap.js';

const MAX_REQUEST_BYTES = 4096;
const PREVIEW_ID_KEY = randomBytes(32);

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

async function parseRepositoryUrl(request) {
  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return { status: error?.code === 'BODY_TOO_LARGE' ? 413 : 400, error: 'invalid-request' };
  }
  if (!isRequestObject(body) || Object.keys(body).some((key) => key !== 'url')
    || typeof body.url !== 'string') {
    return { status: 400, error: 'invalid-request' };
  }
  return { url: body.url };
}

function firstSyncPreviewError(error) {
  if (error?.code === 'INVALID_REPOSITORY_REMOTE') return { status: 400, error: 'invalid-repository-url' };
  if (error?.code === 'INVALID_MACHINE_ID') return { status: 400, error: 'invalid-machine-id' };
  if (error?.code === 'GIT_NOT_INSTALLED') return { status: 503, error: 'git-not-installed' };
  if (error?.code === 'GIT_TIMEOUT') return { status: 504, error: 'git-timeout' };
  if (error?.code === 'REMOTE_STATE_TOO_LARGE') return { status: 413, error: 'remote-state-too-large' };
  if (error?.code === 'REMOTE_STATE_INVALID') return { status: 422, error: 'remote-state-invalid' };
  if (error?.code === 'REMOTE_FILTER_UNSUPPORTED') return { status: 422, error: 'remote-state-unavailable' };
  if (error?.code === 'GIT_ACCESS_FAILED') return { status: 422, error: 'git-access-failed' };
  return { status: 503, error: 'preview-unavailable' };
}

function bootstrapPushError(error) {
  const code = error?.code;
  if (code === 'REPOSITORY_CHANGED' || code === 'REPOSITORY_NOT_EMPTY') return { status: 409, error: 'repository-changed' };
  if (code === 'LOCAL_SOURCES_UNAVAILABLE') return { status: 422, error: 'preview-not-confirmable' };
  if (code === 'GIT_PUSH_FAILED') return { status: 422, error: 'git-push-failed' };
  if (code === 'STATE_TOO_LARGE') return { status: 413, error: 'state-too-large' };
  return firstSyncPreviewError(error);
}

function applyError(error) {
  const code = error?.code;
  if (code === 'NOTHING_TO_APPLY') return { status: 422, error: 'nothing-to-apply' };
  if (code === 'INVALID_PLAN') return { status: 422, error: 'preview-not-confirmable' };
  if (code === 'APPLY_TARGET_UNAVAILABLE') return { status: 422, error: 'apply-target-unavailable' };
  if (code === 'APPLY_LIMIT_EXCEEDED') return { status: 413, error: 'apply-too-large' };
  if (code === 'APPLY_JOURNAL_INVALID') return { status: 503, error: 'apply-recovery-required' };
  return { status: 500, error: 'apply-failed' };
}

async function createFirstSyncReview(url, machineId, { openChamberDir, openCodeDir, stateReader }) {
  const normalizedRemote = normalizeGitHubRemote(url);
  if (machineId !== undefined && !isValidMachineId(machineId)) {
    throw Object.assign(new Error('Invalid machine identity'), { code: 'INVALID_MACHINE_ID' });
  }
  const remote = await stateReader(url);
  if (!remote || typeof remote.empty !== 'boolean' || !Array.isArray(remote.states)
    || (remote.empty && remote.states.length !== 0)) {
    throw Object.assign(new Error('Invalid remote state'), { code: 'REMOTE_STATE_INVALID' });
  }
  const local = await readLocalSnapshot({ openChamberDir, openCodeDir });
  const comparison = createBootstrapPreview(local, remote.states);
  if (!machineId) comparison.canConfirm = false;
  const previewId = createHmac('sha256', PREVIEW_ID_KEY).update(stableJson({
    remote: normalizedRemote.url,
    machineId: machineId ?? null,
    empty: remote.empty,
    states: remote.states,
    local,
  })).digest('hex');
  return {
    empty: remote.empty,
    remoteMachineCount: remote.states.length,
    machineIdentityReady: Boolean(machineId),
    machineRegistered: Boolean(machineId && remote.states.some((state) => state.machineId === machineId)),
    comparison,
    previewId,
    local,
    remote,
  };
}

async function parseFirstSyncPreviewRequest(request) {
  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return { status: error?.code === 'BODY_TOO_LARGE' ? 413 : 400, error: 'invalid-request' };
  }
  if (!isRequestObject(body) || Object.keys(body).some((key) => !['url', 'machineId'].includes(key))
    || typeof body.url !== 'string'
    || (body.machineId !== undefined && !isValidMachineId(body.machineId))) {
    return { status: 400, error: 'invalid-request' };
  }
  return body;
}

async function parseConfirmationRequest(request) {
  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return { status: error?.code === 'BODY_TOO_LARGE' ? 413 : 400, error: 'invalid-request' };
  }
  const allowedKeys = new Set(['url', 'machineId', 'previewId', 'resolutions', 'confirmed']);
  if (!isRequestObject(body) || Object.keys(body).some((key) => !allowedKeys.has(key))
    || typeof body.url !== 'string'
    || !isValidMachineId(body.machineId)
    || typeof body.previewId !== 'string' || !/^[a-f0-9]{64}$/.test(body.previewId)
    || typeof body.resolutions !== 'string' || !/^[LR]{0,200}$/.test(body.resolutions)
    || body.confirmed !== true) {
    return { status: 400, error: 'invalid-request' };
  }
  return body;
}

async function revalidateConfirmedPlan(parsed, { openChamberDir, openCodeDir, stateReader }) {
  const review = await createFirstSyncReview(parsed.url, parsed.machineId, { openChamberDir, openCodeDir, stateReader });
  if (review.previewId !== parsed.previewId) {
    return { errorStatus: 409, error: 'preview-stale' };
  }
  const conflicts = review.comparison.items.filter((item) => item.action === 'conflict');
  if (!review.comparison.canConfirm || parsed.resolutions.length !== conflicts.length) {
    return { errorStatus: 422, error: 'preview-not-confirmable' };
  }
  return { review };
}

export function createServiceServer({
  token,
  openChamberDir,
  openCodeDir,
  gitProbe = probeGitHubRepo,
  stateReader = readRemoteMachineStates,
  repositoryPusher = pushBootstrapState,
  applyWriter = applyPlanToFiles,
}) {
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
    if (request.method === 'POST' && pathname === '/repository/preview') {
      const parsed = await parseFirstSyncPreviewRequest(request);
      if (parsed.error) {
        sendJson(response, parsed.status, { error: parsed.error });
        return;
      }
      try {
        const review = await createFirstSyncReview(parsed.url, parsed.machineId, { openChamberDir, openCodeDir, stateReader });
        sendJson(response, 200, {
          empty: review.empty,
          remoteMachineCount: review.remoteMachineCount,
          machineIdentityReady: review.machineIdentityReady,
          machineRegistered: review.machineRegistered,
          comparison: review.comparison,
          previewId: review.previewId,
        });
      } catch (error) {
        const failure = firstSyncPreviewError(error);
        sendJson(response, failure.status, { error: failure.error });
      }
      return;
    }
    if (request.method === 'POST' && pathname === '/repository/confirm') {
      const parsed = await parseConfirmationRequest(request);
      if (parsed.error) {
        sendJson(response, parsed.status, { error: parsed.error });
        return;
      }
      try {
        const result = await revalidateConfirmedPlan(parsed, { openChamberDir, openCodeDir, stateReader });
        if (result.error) {
          sendJson(response, result.errorStatus, { error: result.error });
          return;
        }
        const review = result.review;
        if (review.remote.states.length === 0) {
          const bootstrap = createRepositoryBootstrapState({
            machineId: parsed.machineId,
            local: review.local,
            remote: review.remote,
          });
          sendJson(response, 200, {
            confirmed: true,
            changesMade: false,
            bootstrap: {
              branch: bootstrap.branch,
              path: bootstrap.path,
              entryCount: Object.keys(bootstrap.state.entries).length,
            },
          });
        } else {
          sendJson(response, 200, { confirmed: true, changesMade: false });
        }
      } catch (error) {
        const failure = firstSyncPreviewError(error);
        sendJson(response, failure.status, { error: failure.error });
      }
      return;
    }
    if (request.method === 'POST' && pathname === '/repository/bootstrap') {
      const parsed = await parseConfirmationRequest(request);
      if (parsed.error) {
        sendJson(response, parsed.status, { error: parsed.error });
        return;
      }
      try {
        const result = await revalidateConfirmedPlan(parsed, { openChamberDir, openCodeDir, stateReader });
        if (result.error) {
          sendJson(response, result.errorStatus, { error: result.error });
          return;
        }
        const review = result.review;
        if (review.remote.states.length !== 0) {
          sendJson(response, 409, { error: 'repository-changed' });
          return;
        }
        const now = Date.now();
        const bootstrap = createRepositoryBootstrapState({
          machineId: parsed.machineId,
          local: review.local,
          remote: review.remote,
          now,
        });
        const pushed = await repositoryPusher({
          url: parsed.url,
          branch: bootstrap.branch,
          path: bootstrap.path,
          content: bootstrap.content,
          commitTimestamp: now,
        });
        if (!pushed || pushed.branch !== bootstrap.branch || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(pushed.commit ?? '')) {
          throw Object.assign(new Error('Invalid push result'), { code: 'GIT_PUSH_FAILED' });
        }
        sendJson(response, 200, {
          confirmed: true,
          changesMade: true,
          bootstrap: {
            branch: bootstrap.branch,
            path: bootstrap.path,
            entryCount: Object.keys(bootstrap.state.entries).length,
          },
          commit: pushed.commit,
        });
      } catch (error) {
        const failure = bootstrapPushError(error);
        sendJson(response, failure.status, { error: failure.error });
      }
      return;
    }
    if (request.method === 'POST' && pathname === '/repository/apply') {
      const parsed = await parseConfirmationRequest(request);
      if (parsed.error) {
        sendJson(response, parsed.status, { error: parsed.error });
        return;
      }
      try {
        const result = await revalidateConfirmedPlan(parsed, { openChamberDir, openCodeDir, stateReader });
        if (result.error) {
          sendJson(response, result.errorStatus, { error: result.error });
          return;
        }
        const review = result.review;
        if (review.remote.empty) {
          sendJson(response, 422, { error: 'nothing-to-apply' });
          return;
        }
        const remote = mergeMachineStates(review.remote.states);
        const plan = planApplyChanges({
          items: review.comparison.items,
          remoteValues: remote.values,
          tombstones: remote.tombstones,
          resolutions: parsed.resolutions,
        });
        const planId = createHash('sha256').update(stableJson(plan)).digest('hex');
        const applied = await applyWriter(plan, {
          openChamberDir,
          openCodeDir,
          journalPath: defaultApplyJournalPath(openChamberDir),
          planId,
        });
        sendJson(response, 200, {
          confirmed: true,
          changesMade: true,
          applied: applied.applied,
          recovered: applied.recovered === true,
        });
      } catch (error) {
        const failure = applyError(error);
        sendJson(response, failure.status, { error: failure.error });
      }
      return;
    }
    if (request.method === 'POST' && pathname === '/repository/test') {
      const parsed = await parseRepositoryUrl(request);
      if (parsed.error) {
        sendJson(response, parsed.status, { error: parsed.error });
        return;
      }
      try {
        const result = await gitProbe(parsed.url);
        sendJson(response, 200, { accessible: true, repository: result.repository, url: result.url });
      } catch (error) {
        const code = error?.code;
        const status = code === 'INVALID_REPOSITORY_REMOTE' ? 400
          : code === 'GIT_NOT_INSTALLED' ? 503
            : code === 'GIT_TIMEOUT' ? 504 : 422;
        const publicCode = code === 'INVALID_REPOSITORY_REMOTE' ? 'invalid-repository-url'
          : code === 'GIT_NOT_INSTALLED' ? 'git-not-installed'
            : code === 'GIT_TIMEOUT' ? 'git-timeout' : 'git-access-failed';
        const diagnostics = sanitizeRepositoryDiagnostics(error?.diagnostics);
        sendJson(response, status, { error: publicCode, ...(diagnostics ? { diagnostics } : {}) });
      }
      return;
    }
    sendJson(response, 404, { error: 'not-found' });
  });
}
