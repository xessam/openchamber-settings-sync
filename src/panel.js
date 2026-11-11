import { connectHost } from '@openchamber/sdk';
import { applyHostReady, mountButton, mountTextField } from '@openchamber/sdk/ui';
import { canConfirmFirstSync } from './first-sync-confirmation.js';
import { getOrCreateMachineId } from './machine-identity.js';
import { repositoryServiceErrorMessage } from './service-errors.js';
import { runFirstSyncConfirmation, runFirstSyncPreview, runRepositoryApply, runRepositoryBootstrap, runRepositoryProbe } from './repository-service.js';
import { formatRepositoryDiagnostics } from './repository-diagnostics.js';

const host = connectHost();
const root = document.querySelector('#root');
const repoFieldRoot = document.querySelector('#repo-field');
const repoActionRoot = document.querySelector('#repo-action');
const repoStatus = document.querySelector('#repo-status');
const repoLog = document.querySelector('#repo-log');
const previewActionRoot = document.querySelector('#preview-action');
const previewStatus = document.querySelector('#preview-status');
const sourcesRoot = document.querySelector('#sources');
const firstSyncActionRoot = document.querySelector('#first-sync-action');
const firstSyncStatus = document.querySelector('#first-sync-status');
const firstSyncPreviewRoot = document.querySelector('#first-sync-preview');
const firstSyncConfirmation = document.querySelector('#first-sync-confirmation');
const firstSyncReviewed = document.querySelector('#first-sync-reviewed');
const firstSyncConfirmButton = document.querySelector('#first-sync-confirm-button');
const firstSyncPushButton = document.querySelector('#first-sync-push-button');
const firstSyncApplyButton = document.querySelector('#first-sync-apply-button');
const firstSyncConfirmStatus = document.querySelector('#first-sync-confirm-status');
const machineIdentityStatus = document.querySelector('#machine-identity-status');
let mounted = false;
let repoUrl = '';
let repoField;
let repoTestButton;
let previewButton;
let firstSyncButton;
let machineId;
let activeFirstSyncPreview;
let activeFirstSyncPreviewId;
let firstSyncChoices = Object.create(null);
let firstSyncConfirmationPending = false;
let firstSyncApproved = false;
let firstSyncBootstrapReady = false;
let firstSyncPushPending = false;
let firstSyncPushed = false;
let firstSyncRepositoryEmpty;
let firstSyncApplyPending = false;
let firstSyncApplied = false;
let firstSyncReviewGeneration = 0;

const sourceLabels = {
  preferences: 'OpenChamber preferences',
  opencode: 'OpenCode configuration',
  'opencode-files': 'OpenCode agent, command, skill, and plugin files',
  extensions: 'Git-installed extensions',
};

function renderSources(sources) {
  sourcesRoot.replaceChildren();
  for (const source of sources) {
    const row = document.createElement('li');
    row.className = 'source';
    const label = document.createElement('span');
    label.className = 'source-label';
    label.textContent = sourceLabels[source.id] ?? 'Other source';
    const state = document.createElement('span');
    state.className = 'source-state';
    state.textContent = source.status === 'ready'
      ? `${source.portableItems} portable items`
      : source.status === 'missing' ? 'Not found' : 'Unavailable';
    row.append(label, state);
    sourcesRoot.append(row);
  }
}

function resetFirstSyncReview(message) {
  firstSyncReviewGeneration += 1;
  activeFirstSyncPreview = undefined;
  activeFirstSyncPreviewId = undefined;
  firstSyncChoices = Object.create(null);
  firstSyncConfirmationPending = false;
  firstSyncApproved = false;
  firstSyncBootstrapReady = false;
  firstSyncPushPending = false;
  firstSyncPushed = false;
  firstSyncRepositoryEmpty = undefined;
  firstSyncApplyPending = false;
  firstSyncApplied = false;
  firstSyncPreviewRoot.replaceChildren();
  firstSyncConfirmation.hidden = true;
  firstSyncReviewed.checked = false;
  firstSyncConfirmButton.disabled = true;
  firstSyncConfirmButton.textContent = 'Confirm this plan';
  firstSyncPushButton.hidden = true;
  firstSyncPushButton.textContent = 'Push initial state';
  firstSyncApplyButton.hidden = true;
  firstSyncApplyButton.textContent = 'Apply to this machine';
  firstSyncConfirmStatus.textContent = '';
  firstSyncButton?.update({ loading: false });
  if (message) firstSyncStatus.textContent = message;
}

function isFirstSyncPayload(value) {
  if (!value || typeof value !== 'object' || typeof value.empty !== 'boolean'
    || !Number.isInteger(value.remoteMachineCount) || value.remoteMachineCount < 0 || value.remoteMachineCount > 64
    || typeof value.machineIdentityReady !== 'boolean' || typeof value.machineRegistered !== 'boolean'
    || typeof value.previewId !== 'string' || !/^[a-f0-9]{64}$/.test(value.previewId)) return false;
  const preview = value.comparison;
  if (!preview || typeof preview !== 'object' || typeof preview.canConfirm !== 'boolean'
    || !Array.isArray(preview.items) || preview.items.length > 200
    || !Array.isArray(preview.blockedSources)
    || ['localOnly', 'remoteOnly', 'conflicts', 'unchanged', 'unsupportedItems', 'incompleteItems', 'omittedItems']
      .some((key) => !Number.isInteger(preview[key]) || preview[key] < 0)) return false;
  return preview.items.every((item) => item && typeof item === 'object'
    && typeof item.key === 'string' && item.key.length <= 1200
    && typeof item.path === 'string' && item.path.length <= 600
    && ['file', 'setting'].includes(item.kind)
    && ['upload', 'download', 'conflict'].includes(item.action)
    && typeof item.complete === 'boolean'
    && ['local', 'remote'].every((side) => item[side] && typeof item[side] === 'object'
      && typeof item[side].present === 'boolean'
      && typeof item[side].deleted === 'boolean'
      && typeof item[side].preview === 'string' && item[side].preview.length <= 32 * 1024
      && typeof item[side].complete === 'boolean'));
}

function updateFirstSyncConfirmation() {
  firstSyncReviewed.disabled = firstSyncConfirmationPending;
  firstSyncPreviewRoot.querySelectorAll('.sync-conflict-choices input').forEach((input) => {
    input.disabled = firstSyncConfirmationPending;
  });
  firstSyncConfirmButton.disabled = firstSyncConfirmationPending || firstSyncApproved || !canConfirmFirstSync(
    activeFirstSyncPreview,
    firstSyncChoices,
    firstSyncReviewed.checked,
  );
  firstSyncPushButton.hidden = !(firstSyncApproved && firstSyncBootstrapReady);
  if (!firstSyncPushButton.hidden) {
    firstSyncPushButton.disabled = firstSyncPushPending || firstSyncPushed;
  }
  firstSyncApplyButton.hidden = !(firstSyncApproved && firstSyncRepositoryEmpty === false) || firstSyncApplied;
  if (!firstSyncApplyButton.hidden) {
    firstSyncApplyButton.disabled = firstSyncApplyPending;
  }
}

function renderPreviewValue(title, value) {
  const section = document.createElement('section');
  section.className = 'sync-value';
  const heading = document.createElement('h4');
  heading.textContent = title;
  const content = document.createElement('pre');
  content.textContent = value.present
    ? value.preview
    : value.deleted ? 'Deleted in the repository.' : 'Not present.';
  section.append(heading, content);
  return section;
}

function renderFirstSyncPreview(payload) {
  const comparison = payload.comparison;
  activeFirstSyncPreview = comparison;
  activeFirstSyncPreviewId = payload.previewId;
  firstSyncChoices = Object.create(null);
  firstSyncApproved = false;
  firstSyncBootstrapReady = false;
  firstSyncPushPending = false;
  firstSyncPushed = false;
  firstSyncRepositoryEmpty = payload.empty;
  firstSyncApplyPending = false;
  firstSyncApplied = false;
  firstSyncPreviewRoot.replaceChildren();
  firstSyncConfirmStatus.textContent = '';
  firstSyncReviewed.checked = false;

  const summary = document.createElement('p');
  summary.className = 'sync-summary';
  summary.textContent = `${payload.empty ? 'The repository has no branch history yet. ' : `Compared ${payload.remoteMachineCount} remote machine${payload.remoteMachineCount === 1 ? '' : 's'}. `}`
    + `Proposed: ${comparison.localOnly} upload${comparison.localOnly === 1 ? '' : 's'}, `
    + `${comparison.remoteOnly} download${comparison.remoteOnly === 1 ? '' : 's'}, `
    + `${comparison.conflicts} conflict${comparison.conflicts === 1 ? '' : 's'}, `
    + `${comparison.unchanged} unchanged.`;
  firstSyncPreviewRoot.append(summary);

  const identity = document.createElement('p');
  identity.className = payload.machineIdentityReady ? 'sync-summary' : 'sync-warning';
  identity.textContent = !payload.machineIdentityReady
    ? 'No stable device identity is available; confirmation and bootstrap are disabled.'
    : payload.machineRegistered
      ? 'This device already has a state file in the repository.'
      : 'This device does not yet have a state file in the repository.';
  firstSyncPreviewRoot.append(identity);

  if (comparison.blockedSources.length > 0) {
    const warning = document.createElement('p');
    warning.className = 'sync-warning';
    warning.textContent = `Review blocked: these local sources are missing or unavailable: ${comparison.blockedSources.map((id) => sourceLabels[id] ?? 'Unknown source').join(', ')}.`;
    firstSyncPreviewRoot.append(warning);
  }
  for (const [count, label, noun] of [
    [comparison.unsupportedItems, 'Unsupported remote items', 'remote item'],
    [comparison.incompleteItems, 'Items withheld from preview', 'item'],
    [comparison.omittedItems, 'Changes omitted by preview limits', 'change'],
  ]) {
    if (!count) continue;
    const warning = document.createElement('p');
    warning.className = 'sync-warning';
    warning.textContent = `${label}: ${count} ${noun}${count === 1 ? '' : 's'}. Confirmation is disabled.`;
    firstSyncPreviewRoot.append(warning);
  }

  if (comparison.items.length === 0 && comparison.unsupportedItems === 0) {
    const empty = document.createElement('p');
    empty.className = 'sync-empty';
    empty.textContent = 'No differences to review.';
    firstSyncPreviewRoot.append(empty);
  }

  const list = document.createElement('ol');
  list.className = 'sync-change-list';
  comparison.items.forEach((item, index) => {
    const row = document.createElement('li');
    row.className = 'sync-change';
    const header = document.createElement('div');
    header.className = 'sync-change-header';
    const title = document.createElement('h3');
    title.textContent = item.path;
    const action = document.createElement('span');
    action.className = `sync-action sync-action-${item.action}`;
    action.textContent = item.action === 'upload' ? 'Upload to repository'
      : item.action === 'download' ? 'Apply to this machine' : 'Choose conflict resolution';
    header.append(title, action);
    row.append(header);

    const values = document.createElement('details');
    values.className = 'sync-values';
    const valuesSummary = document.createElement('summary');
    valuesSummary.textContent = 'Inspect local and repository values';
    values.append(valuesSummary, renderPreviewValue('This machine', item.local), renderPreviewValue('Repository', item.remote));
    row.append(values);

    if (item.action === 'conflict') {
      const choices = document.createElement('fieldset');
      choices.className = 'sync-conflict-choices';
      const legend = document.createElement('legend');
      legend.textContent = 'Resolve this conflict';
      choices.append(legend);
      for (const choice of ['local', 'remote']) {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = `sync-conflict-${index}`;
        input.value = choice;
        input.checked = firstSyncChoices[item.key] === choice;
        input.addEventListener('change', () => {
          firstSyncChoices[item.key] = choice;
          firstSyncApproved = false;
          firstSyncConfirmStatus.textContent = '';
          updateFirstSyncConfirmation();
        });
        label.append(input, document.createTextNode(choice === 'local' ? 'Keep this machine’s value' : item.remote.deleted ? 'Apply repository deletion' : 'Use repository value'));
        choices.append(label);
      }
      row.append(choices);
    }
    list.append(row);
  });
  if (comparison.items.length > 0) firstSyncPreviewRoot.append(list);

  firstSyncConfirmation.hidden = false;
  firstSyncStatus.textContent = 'Comparison ready. Nothing has been uploaded or changed.';
  updateFirstSyncConfirmation();
}

function firstSyncErrorMessage(code) {
  const messages = {
    'invalid-repository-url': 'Enter a credential-free GitHub HTTPS URL or SSH address.',
    'git-not-installed': 'Git is not available to the OpenChamber service.',
    'git-timeout': 'The read-only repository comparison timed out. Retry when the network is stable.',
    'git-access-failed': 'Git could not read this repository. Check the address and this machine’s access.',
    'remote-state-invalid': 'The repository contains unsupported or malformed sync state. No changes were made.',
    'remote-state-too-large': 'The repository state exceeds the safe preview limit. No changes were made.',
    'remote-state-unavailable': 'The repository server could not provide bounded state data. No changes were made.',
    'preview-stale': 'Local or remote state changed after this preview. Run the comparison again before confirming.',
    'preview-not-confirmable': 'This comparison is incomplete or missing a conflict choice. Refresh it and review every change.',
    'repository-changed': 'The repository changed during the push or no longer matches this preview. Run the comparison again; the remote was not changed.',
    'git-push-failed': 'Git could not push to the repository. Check write access for this machine; the remote was not changed.',
    'state-too-large': 'The prepared initial state exceeds the safe push limit. Nothing was uploaded.',
    'nothing-to-apply': 'This confirmed plan has no changes to apply to this machine.',
    'apply-target-unavailable': 'A local target file is missing, unreadable, or unsafe to replace. Nothing was changed.',
    'apply-too-large': 'A merged file would exceed the safe size limit. Nothing was changed.',
    'apply-recovery-required': 'An earlier interrupted apply left a recovery marker that could not be resolved. Nothing was changed; inspect the OpenChamber config directory.',
    'apply-failed': 'Applying the confirmed changes failed partway. Interrupted applies are rolled back on the next apply attempt.',
  };
  return messages[code] ?? 'Could not prepare a safe first-sync comparison. No changes were made.';
}

async function previewFirstSync() {
  const url = repoUrl.trim();
  if (!url) {
    resetFirstSyncReview('Enter a repository address before comparing.');
    return;
  }
  resetFirstSyncReview('Preparing a read-only local and repository comparison…');
  const generation = firstSyncReviewGeneration;
  firstSyncButton.update({ loading: true });
  try {
    const response = await runFirstSyncPreview((request) => host.serviceRequest(request), url, { machineId });
    if (generation !== firstSyncReviewGeneration) return;
    let payload;
    try {
      payload = JSON.parse(response.body);
    } catch {
      throw new Error('invalid-preview');
    }
    if (response.status !== 200) {
      resetFirstSyncReview(firstSyncErrorMessage(payload.error));
      return;
    }
    if (!isFirstSyncPayload(payload)) throw new Error('invalid-preview');
    renderFirstSyncPreview(payload);
  } catch (error) {
    if (generation === firstSyncReviewGeneration) {
      resetFirstSyncReview(error?.code ? repositoryServiceErrorMessage(error) : 'Could not prepare a safe first-sync comparison. No changes were made.');
    }
  } finally {
    if (generation === firstSyncReviewGeneration) firstSyncButton.update({ loading: false });
  }
}

function confirmFirstSyncPlan() {
  if (firstSyncConfirmationPending || firstSyncApproved
    || !canConfirmFirstSync(activeFirstSyncPreview, firstSyncChoices, firstSyncReviewed.checked)) return;
  void submitFirstSyncConfirmation();
}

async function submitFirstSyncConfirmation() {
  const generation = firstSyncReviewGeneration;
  const previewId = activeFirstSyncPreviewId;
  const url = repoUrl.trim();
  firstSyncConfirmationPending = true;
  firstSyncConfirmButton.textContent = 'Rechecking preview…';
  updateFirstSyncConfirmation();
  const resolutions = activeFirstSyncPreview.items
    .filter((item) => item.action === 'conflict')
    .map((item) => firstSyncChoices[item.key] === 'local' ? 'L' : 'R')
    .join('');
  try {
    const response = await runFirstSyncConfirmation((request) => host.serviceRequest(request), {
      url,
      machineId,
      previewId,
      resolutions,
      confirmed: true,
    });
    if (generation !== firstSyncReviewGeneration) return;
    let payload;
    try {
      payload = JSON.parse(response.body);
    } catch {
      payload = {};
    }
    if (response.status !== 200 || payload.confirmed !== true || payload.changesMade !== false) {
      if (response.status === 409 || payload.error === 'preview-stale') {
        resetFirstSyncReview(firstSyncErrorMessage('preview-stale'));
      } else {
        firstSyncConfirmStatus.textContent = response.status === 422
          ? firstSyncErrorMessage(payload.error)
          : repositoryServiceErrorMessage({ code: payload.error });
      }
      return;
    }
    firstSyncApproved = true;
    firstSyncConfirmButton.textContent = 'Plan confirmed';
    if (payload.bootstrap && typeof payload.bootstrap.path === 'string'
      && payload.bootstrap.branch === 'main' && Number.isInteger(payload.bootstrap.entryCount)) {
      firstSyncBootstrapReady = true;
      firstSyncConfirmStatus.textContent = `Initial state prepared at ${payload.bootstrap.path} (${payload.bootstrap.entryCount} entries). Nothing has been uploaded yet. Pushing is a separate step that writes only that file to the repository.`;
    } else {
      firstSyncConfirmStatus.textContent = 'The service rechecked and confirmed this plan. Applying it to this machine is a separate step; nothing has been changed yet.';
    }
  } catch (error) {
    if (generation === firstSyncReviewGeneration) {
      firstSyncConfirmStatus.textContent = repositoryServiceErrorMessage(error);
    }
  } finally {
    if (generation === firstSyncReviewGeneration) {
      firstSyncConfirmationPending = false;
      if (!firstSyncApproved && activeFirstSyncPreview) firstSyncConfirmButton.textContent = 'Confirm this plan';
      updateFirstSyncConfirmation();
    }
  }
}

async function submitFirstSyncBootstrap() {
  if (!firstSyncApproved || firstSyncPushed || firstSyncPushPending || !firstSyncBootstrapReady) return;
  const generation = firstSyncReviewGeneration;
  const previewId = activeFirstSyncPreviewId;
  const url = repoUrl.trim();
  firstSyncPushPending = true;
  firstSyncPushButton.textContent = 'Pushing initial state…';
  updateFirstSyncConfirmation();
  const resolutions = activeFirstSyncPreview.items
    .filter((item) => item.action === 'conflict')
    .map((item) => firstSyncChoices[item.key] === 'local' ? 'L' : 'R')
    .join('');
  try {
    const response = await runRepositoryBootstrap((request) => host.serviceRequest(request), {
      url,
      machineId,
      previewId,
      resolutions,
      confirmed: true,
    });
    if (generation !== firstSyncReviewGeneration) return;
    let payload;
    try {
      payload = JSON.parse(response.body);
    } catch {
      payload = {};
    }
    if (response.status !== 200 || payload.confirmed !== true || payload.changesMade !== true) {
      if (response.status === 409) {
        resetFirstSyncReview(firstSyncErrorMessage(payload.error ?? 'preview-stale'));
      } else {
        firstSyncConfirmStatus.textContent = firstSyncErrorMessage(payload.error);
      }
      return;
    }
    firstSyncPushed = true;
    firstSyncPushButton.textContent = 'Initial state pushed';
    const commit = typeof payload.commit === 'string' && /^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(payload.commit)
      ? payload.commit.slice(0, 7)
      : undefined;
    firstSyncConfirmStatus.textContent = `Initial state pushed to the repository${commit ? ` (commit ${commit})` : ''}. No local files were changed.`;
  } catch (error) {
    if (generation === firstSyncReviewGeneration) {
      firstSyncConfirmStatus.textContent = repositoryServiceErrorMessage(error);
    }
  } finally {
    if (generation === firstSyncReviewGeneration) {
      firstSyncPushPending = false;
      if (!firstSyncPushed) firstSyncPushButton.textContent = 'Push initial state';
      updateFirstSyncConfirmation();
    }
  }
}

async function submitFirstSyncApply() {
  if (!firstSyncApproved || firstSyncApplied || firstSyncApplyPending || firstSyncRepositoryEmpty !== false) return;
  const generation = firstSyncReviewGeneration;
  const previewId = activeFirstSyncPreviewId;
  const url = repoUrl.trim();
  firstSyncApplyPending = true;
  firstSyncApplyButton.textContent = 'Applying changes…';
  updateFirstSyncConfirmation();
  const resolutions = activeFirstSyncPreview.items
    .filter((item) => item.action === 'conflict')
    .map((item) => firstSyncChoices[item.key] === 'local' ? 'L' : 'R')
    .join('');
  try {
    const response = await runRepositoryApply((request) => host.serviceRequest(request), {
      url,
      machineId,
      previewId,
      resolutions,
      confirmed: true,
    });
    if (generation !== firstSyncReviewGeneration) return;
    let payload;
    try {
      payload = JSON.parse(response.body);
    } catch {
      payload = {};
    }
    if (response.status !== 200 || payload.confirmed !== true || payload.changesMade !== true) {
      if (response.status === 409) {
        resetFirstSyncReview(firstSyncErrorMessage(payload.error ?? 'preview-stale'));
      } else {
        firstSyncConfirmStatus.textContent = firstSyncErrorMessage(payload.error);
      }
      return;
    }
    firstSyncApplied = true;
    firstSyncApplyButton.textContent = 'Changes applied';
    const count = Number.isInteger(payload.applied) && payload.applied >= 0 ? payload.applied : undefined;
    firstSyncConfirmStatus.textContent = `Applied ${count ?? 'the approved'} change${count === 1 ? '' : 's'} from the repository to this machine. The repository was not changed; push this machine's state in a later comparison.`;
  } catch (error) {
    if (generation === firstSyncReviewGeneration) {
      firstSyncConfirmStatus.textContent = repositoryServiceErrorMessage(error);
    }
  } finally {
    if (generation === firstSyncReviewGeneration) {
      firstSyncApplyPending = false;
      if (!firstSyncApplied) firstSyncApplyButton.textContent = 'Apply to this machine';
      updateFirstSyncConfirmation();
    }
  }
}

function repoErrorMessage(error, remote) {
  if (error === 'invalid-repository-url') return 'Enter a GitHub HTTPS URL or SSH address such as git@github.com:owner/repo.git.';
  if (error === 'git-not-installed') return 'Git is not available to the OpenChamber service on this machine.';
  if (error === 'git-timeout') return 'Git did not respond in time. Check your network and try again.';
  if (remote.startsWith('git@github.com:')) return 'SSH access failed. See Git test diagnostics for more information.';
  return 'Git could not access this repository. Check the URL and authenticate with this machine’s Git credential helper, then retry.';
}

async function testRepository() {
  const url = repoUrl.trim();
  if (!url) {
    repoStatus.textContent = 'Enter a GitHub repository URL first.';
    repoLog.textContent = 'No test started: repository address is empty.';
    return;
  }

  const log = ['Starting local Git service…'];
  const updateLog = () => { repoLog.textContent = log.join('\n'); };
  updateLog();
  repoTestButton.update({ loading: true });
  repoStatus.textContent = 'Starting local Git service…';
  let payload;
  try {
    const response = await runRepositoryProbe(
      (request) => host.serviceRequest(request),
      url,
      () => {
        repoStatus.textContent = 'Testing read access with Git…';
        log.push('Service ready. Testing repository read access…');
        updateLog();
      },
    );
    payload = JSON.parse(response.body);
    if (response.status !== 200 || payload.accessible !== true || typeof payload.url !== 'string') {
      repoStatus.textContent = repoErrorMessage(payload.error, url);
      log.push('Test failed.', ...formatRepositoryDiagnostics(payload.diagnostics), repoStatus.textContent);
      updateLog();
      return;
    }
    log.push('Git repository read access succeeded. No files were changed.');
    updateLog();
  } catch (error) {
    repoStatus.textContent = repositoryServiceErrorMessage(error);
    log.push(`Test failed: ${repoStatus.textContent}`);
    updateLog();
    return;
  } finally {
    repoTestButton.update({ loading: false });
  }

  repoUrl = payload.url;
  repoField.update({ value: repoUrl });
  try {
    await host.storage.set('repositoryUrl', repoUrl);
    repoStatus.textContent = `Git can read ${payload.repository}. No files were changed.`;
  } catch {
    repoStatus.textContent = 'Git can read the repository, but its URL could not be saved in extension storage.';
  }
}

async function preview() {
  previewButton.update({ loading: true });
  previewStatus.textContent = 'Reading local configuration…';
  sourcesRoot.replaceChildren();
  try {
    const result = await host.serviceRequest({ method: 'GET', path: '/preview' });
    if (result.status !== 200) throw new Error('preview-unavailable');
    const payload = JSON.parse(result.body);
    if (!Array.isArray(payload.sources)) throw new Error('invalid-preview');
    renderSources(payload.sources);
    previewStatus.textContent = 'Preview ready. Nothing has been synced or changed.';
  } catch {
    previewStatus.textContent = 'Could not read the local configuration. Check that the service is enabled and try again.';
  } finally {
    previewButton.update({ loading: false });
  }
}

async function mount(context) {
  if (mounted) return;
  mounted = true;
  try {
    const savedUrl = await host.storage.get('repositoryUrl');
    if (typeof savedUrl === 'string') repoUrl = savedUrl;
  } catch {
    // The input remains usable when extension storage is unavailable.
  }
  try {
    machineId = await getOrCreateMachineId({
      storage: host.storage,
      deviceStorageAvailable: context?.features?.deviceStorage === true,
      lockManager: globalThis.navigator?.locks,
    });
    machineIdentityStatus.textContent = `Stable per-device identity ${machineId.slice(0, 8)}… is ready for repository bootstrap.`;
  } catch {
    machineId = undefined;
    machineIdentityStatus.textContent = 'Stable per-device identity is unavailable on this host; repository bootstrap is disabled.';
  }
  repoField = mountTextField(repoFieldRoot, {
    label: 'GitHub repository address',
    value: repoUrl,
    placeholder: 'git@github.com:owner/repo.git',
    helper: 'Use HTTPS with a Git credential helper or SSH with a non-interactive key. Never put credentials in the address.',
    mono: true,
    onChange: (value) => {
      repoUrl = value;
      repoField.update({ value });
      resetFirstSyncReview('Repository address changed. Run a new first-sync comparison.');
    },
  });
  repoTestButton = mountButton(repoActionRoot, {
    label: 'Test Git access',
    variant: 'default',
    onClick: () => void testRepository(),
  });
  previewButton = mountButton(previewActionRoot, {
    label: 'Preview sync scope',
    variant: 'secondary',
    onClick: () => void preview(),
  });
  firstSyncButton = mountButton(firstSyncActionRoot, {
    label: 'Compare with repository',
    variant: 'secondary',
    onClick: () => void previewFirstSync(),
  });
  firstSyncReviewed.addEventListener('change', () => {
    firstSyncApproved = false;
    firstSyncConfirmStatus.textContent = '';
    firstSyncConfirmButton.textContent = 'Confirm this plan';
    updateFirstSyncConfirmation();
  });
  firstSyncConfirmButton.addEventListener('click', confirmFirstSyncPlan);
  firstSyncPushButton.addEventListener('click', () => void submitFirstSyncBootstrap());
  firstSyncApplyButton.addEventListener('click', () => void submitFirstSyncApply());
}

host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  if (root) void mount(context);
});
