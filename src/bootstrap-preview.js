import { Buffer } from 'node:buffer';

import { containsCredentialMarker } from './credential-scan.js';
import { decodeOpenCodeKeyPath } from './local-snapshot.js';
import { decodePortableFileKey } from './portable-files.js';
import { isPortableOpenCodeConfigKey, isPortablePreferenceField } from './snapshot.js';
import { mergeMachineStates, stableJson } from './state.js';

const SOURCE_IDS = ['preferences', 'opencode', 'opencode-files', 'extensions'];
const MAX_PREVIEW_ITEMS = 200;
const MAX_PREVIEW_ITEM_BYTES = 32 * 1024;
const MAX_PREVIEW_TOTAL_BYTES = 512 * 1024;

function isPortableExtensionRepositoryList(value) {
  return Array.isArray(value) && value.every((entry) => {
    if (typeof entry !== 'string') return false;
    try {
      const url = new URL(entry);
      return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
    } catch {
      return false;
    }
  });
}

function describeKey(key, value) {
  if (key.startsWith('preferences.')) {
    const field = key.slice('preferences.'.length);
    return isPortablePreferenceField(field)
      ? { kind: 'setting', path: `OpenChamber preferences · ${field}` }
      : undefined;
  }
  if (key.startsWith('opencode.k')) {
    try {
      const configKey = decodeOpenCodeKeyPath(key);
      return Buffer.byteLength(configKey, 'utf8') <= 256 && isPortableOpenCodeConfigKey(configKey)
        ? { kind: 'setting', path: `OpenCode opencode.json · ${configKey}` }
        : undefined;
    } catch {
      return undefined;
    }
  }
  if (key === 'extensions.repositories') {
    return isPortableExtensionRepositoryList(value)
      ? { kind: 'setting', path: 'OpenChamber extensions.json · Git origins' }
      : undefined;
  }
  if (key.startsWith('opencodeFile.')) {
    try {
      return { kind: 'file', path: `OpenCode ${decodePortableFileKey(key)}` };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function previewValue(value, kind, budget) {
  if (kind === 'file' && typeof value !== 'string') {
    return { preview: '[hidden: invalid file value]', complete: false, bytes: 0 };
  }
  const text = kind === 'file' ? value : stableJson(value);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (containsCredentialMarker(text)) {
    return { preview: '[hidden: credential-like content]', complete: false, bytes: 0 };
  }
  if (bytes > MAX_PREVIEW_ITEM_BYTES || bytes > budget) {
    return { preview: '[hidden: value exceeds the preview limit]', complete: false, bytes: 0 };
  }
  return { preview: text, complete: true, bytes };
}

export function createBootstrapPreview(local, states) {
  const remote = mergeMachineStates(states);
  const preview = {
    localOnly: 0,
    remoteOnly: 0,
    conflicts: 0,
    unchanged: 0,
    blockedSources: [],
    unsupportedItems: 0,
    incompleteItems: 0,
    omittedItems: 0,
    items: [],
    canConfirm: false,
  };
  for (const id of SOURCE_IDS) {
    if (local.sources[id]?.status !== 'ready') preview.blockedSources.push(id);
  }

  const tombstones = new Set(remote.tombstones);
  const keys = [...new Set([...Object.keys(local.values), ...Object.keys(remote.values)])].sort();
  let previewBytes = 0;
  const changes = [];
  for (const key of keys) {
    const hasLocal = Object.hasOwn(local.values, key);
    const hasRemote = Object.hasOwn(remote.values, key);
    const remoteDeleted = tombstones.has(key);
    let action;
    if (!hasLocal && !hasRemote) continue;
    if (hasLocal && remoteDeleted) {
      action = 'conflict';
      preview.conflicts += 1;
    } else if (hasLocal && !hasRemote) {
      action = 'upload';
      preview.localOnly += 1;
    } else if (!hasLocal && hasRemote) {
      action = 'download';
      preview.remoteOnly += 1;
    } else if (stableJson(local.values[key]) === stableJson(remote.values[key])) {
      preview.unchanged += 1;
      continue;
    } else {
      action = 'conflict';
      preview.conflicts += 1;
    }

    const localDescription = hasLocal ? describeKey(key, local.values[key]) : undefined;
    const remoteDescription = hasRemote ? describeKey(key, remote.values[key]) : undefined;
    const description = localDescription ?? remoteDescription;
    if (!description || (hasLocal && !localDescription) || (hasRemote && !remoteDescription)
      || (localDescription && remoteDescription
        && (localDescription.kind !== remoteDescription.kind || localDescription.path !== remoteDescription.path))) {
      preview.unsupportedItems += 1;
      continue;
    }
    changes.push({
      key,
      ...description,
      action,
      localValue: hasLocal ? local.values[key] : undefined,
      remoteValue: hasRemote ? remote.values[key] : undefined,
      remoteDeleted,
    });
  }

  changes.sort((left, right) => left.path.localeCompare(right.path));
  for (const change of changes) {
    if (preview.items.length >= MAX_PREVIEW_ITEMS) {
      preview.omittedItems += changes.length - preview.items.length;
      break;
    }
    const budget = MAX_PREVIEW_TOTAL_BYTES - previewBytes;
    const local = change.localValue === undefined
      ? { present: false, deleted: false, preview: '', complete: true }
      : { present: true, deleted: false, ...previewValue(change.localValue, change.kind, budget) };
    previewBytes += local.complete ? Buffer.byteLength(local.preview, 'utf8') : 0;
    const remote = change.remoteDeleted
      ? { present: false, deleted: true, preview: '', complete: true }
      : change.remoteValue === undefined
        ? { present: false, deleted: false, preview: '', complete: true }
        : { present: true, deleted: false, ...previewValue(change.remoteValue, change.kind, MAX_PREVIEW_TOTAL_BYTES - previewBytes) };
    previewBytes += remote.complete ? Buffer.byteLength(remote.preview, 'utf8') : 0;
    if (!local.complete || !remote.complete) preview.incompleteItems += 1;
    preview.items.push({
      key: change.key,
      path: change.path,
      kind: change.kind,
      action: change.action,
      local,
      remote,
      complete: local.complete && remote.complete,
    });
  }

  preview.canConfirm = preview.blockedSources.length === 0
    && preview.unsupportedItems === 0
    && preview.incompleteItems === 0
    && preview.omittedItems === 0;
  return preview;
}
