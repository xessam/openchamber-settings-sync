import { connectHost } from '@openchamber/sdk';
import { applyHostReady, mountButton } from '@openchamber/sdk/ui';

const host = connectHost();
const root = document.querySelector('#root');
const actionRoot = document.querySelector('#action');
const status = document.querySelector('#status');
const sourcesRoot = document.querySelector('#sources');
let mounted = false;
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

async function preview() {
  previewButton.update({ loading: true });
  status.textContent = 'Reading local configuration…';
  sourcesRoot.replaceChildren();
  try {
    const result = await host.serviceRequest({ method: 'GET', path: '/preview' });
    if (result.status !== 200) throw new Error('preview-unavailable');
    const payload = JSON.parse(result.body);
    if (!Array.isArray(payload.sources)) throw new Error('invalid-preview');
    renderSources(payload.sources);
    status.textContent = 'Preview ready. Nothing has been synced or changed.';
  } catch {
    status.textContent = 'Could not read the local configuration. Check that the service is enabled and try again.';
  } finally {
    previewButton.update({ loading: false });
  }
}

function mount() {
  if (mounted) return;
  mounted = true;
  previewButton = mountButton(actionRoot, {
    label: 'Preview sync scope',
    variant: 'default',
    onClick: () => void preview(),
  });
}

host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  if (root) mount();
});
