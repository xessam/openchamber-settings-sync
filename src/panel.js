import { connectHost } from '@openchamber/sdk';
import { applyHostReady, mountButton, mountTextField } from '@openchamber/sdk/ui';
import { repositoryServiceErrorMessage } from './service-errors.js';

const host = connectHost();
const root = document.querySelector('#root');
const repoFieldRoot = document.querySelector('#repo-field');
const repoActionRoot = document.querySelector('#repo-action');
const repoStatus = document.querySelector('#repo-status');
const previewActionRoot = document.querySelector('#preview-action');
const previewStatus = document.querySelector('#preview-status');
const sourcesRoot = document.querySelector('#sources');
let mounted = false;
let repoUrl = '';
let repoField;
let repoTestButton;
let previewButton;

const sourceLabels = {
  preferences: 'OpenChamber preferences',
  opencode: 'OpenCode configuration',
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

function repoErrorMessage(error) {
  if (error === 'invalid-repository-url') return 'Enter a private GitHub URL such as https://github.com/owner/repo.git.';
  if (error === 'git-not-installed') return 'Git is not available to the OpenChamber service on this machine.';
  if (error === 'git-timeout') return 'Git did not respond in time. Check your network and try again.';
  return 'Git could not access this repository. Check the URL and authenticate with this machine’s Git credential helper, then retry.';
}

async function testRepository() {
  const url = repoUrl.trim();
  if (!url) {
    repoStatus.textContent = 'Enter a GitHub repository URL first.';
    return;
  }

  repoTestButton.update({ loading: true });
  repoStatus.textContent = 'Testing read access with Git…';
  let payload;
  try {
    const response = await host.serviceRequest({
      method: 'POST',
      path: '/repository/test',
      body: { url },
    });
    payload = JSON.parse(response.body);
    if (response.status !== 200 || payload.accessible !== true || typeof payload.url !== 'string') {
      repoStatus.textContent = repoErrorMessage(payload.error);
      return;
    }
  } catch (error) {
    repoStatus.textContent = repositoryServiceErrorMessage(error);
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

async function mount() {
  if (mounted) return;
  mounted = true;
  try {
    const savedUrl = await host.storage.get('repositoryUrl');
    if (typeof savedUrl === 'string') repoUrl = savedUrl;
  } catch {
    // The input remains usable when extension storage is unavailable.
  }
  repoField = mountTextField(repoFieldRoot, {
    label: 'Private GitHub repository URL',
    value: repoUrl,
    placeholder: 'https://github.com/owner/repo.git',
    helper: 'Credentials are read from this machine’s Git configuration; the URL must not contain credentials.',
    mono: true,
    onChange: (value) => {
      repoUrl = value;
      repoField.update({ value });
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
}

host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  if (root) void mount();
});
