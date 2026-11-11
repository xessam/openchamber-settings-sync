import { Buffer } from 'node:buffer';

import { containsCredentialMarker } from './credential-scan.js';
import { decodeOpenCodeKeyPath } from './local-snapshot.js';
import { decodePortableFileKey } from './portable-files.js';
import { isPortableOpenCodeConfigKey, isPortablePreferenceField } from './snapshot.js';
import { stableJson } from './state.js';

const MAX_FILE_VALUE_BYTES = 512 * 1024;
const SETTING_TARGET_ORDER = ['preferences', 'opencode', 'extensions'];

function planError(code, message) {
  return Object.assign(new Error(message), { code });
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalValue(value) {
  return JSON.parse(stableJson(value));
}

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

function validateFileText(value) {
  if (typeof value !== 'string') throw planError('INVALID_PLAN', 'Portable file values must be text');
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.toString('utf8') !== value) {
    throw planError('INVALID_PLAN', 'Portable file values must be valid UTF-8 text');
  }
  if (value.includes('\0')) throw planError('INVALID_PLAN', 'Portable file values must not contain null bytes');
  if (bytes.length > MAX_FILE_VALUE_BYTES) throw planError('INVALID_PLAN', 'Portable file values exceed the size limit');
  if (containsCredentialMarker(value)) throw planError('INVALID_PLAN', 'Portable file values must not contain credential-like content');
  return value;
}

function settingChange(target, key, type, rawValue) {
  return {
    kind: 'settings',
    target,
    key,
    type,
    ...(type === 'set' ? { value: canonicalValue(rawValue) } : {}),
  };
}

function changeForKey(item, type, remoteValue) {
  const key = item.key;
  if (key.startsWith('preferences.')) {
    const field = key.slice('preferences.'.length);
    if (!isPortablePreferenceField(field)) throw planError('INVALID_PLAN', 'Unsupported preferences field');
    return settingChange('preferences', field, type, remoteValue);
  }
  if (key.startsWith('opencode.k')) {
    let configKey;
    try {
      configKey = decodeOpenCodeKeyPath(key);
    } catch {
      throw planError('INVALID_PLAN', 'Unsupported OpenCode configuration key');
    }
    if (!isPortableOpenCodeConfigKey(configKey)) throw planError('INVALID_PLAN', 'Unsupported OpenCode configuration key');
    return settingChange('opencode', configKey, type, remoteValue);
  }
  if (key === 'extensions.repositories') {
    if (type === 'set' && !isPortableExtensionRepositoryList(remoteValue)) {
      throw planError('INVALID_PLAN', 'Extension repository lists must be HTTPS Git origins');
    }
    return settingChange('extensions', 'repositories', type, remoteValue);
  }
  if (key.startsWith('opencodeFile.k')) {
    let relativePath;
    try {
      relativePath = decodePortableFileKey(key);
    } catch {
      throw planError('INVALID_PLAN', 'Unsupported portable file path');
    }
    const fileType = type === 'set' ? 'write' : 'delete';
    if (type === 'set') {
      return { kind: 'file', relativePath, type: fileType, text: validateFileText(remoteValue) };
    }
    return { kind: 'file', relativePath, type: fileType };
  }
  throw planError('INVALID_PLAN', 'Unsupported sync key');
}

export function planApplyChanges({ items, remoteValues, tombstones, resolutions }) {
  if (!Array.isArray(items)) throw planError('INVALID_PLAN', 'Expected preview items');
  if (!isRecord(remoteValues)) throw planError('INVALID_PLAN', 'Expected remote values');
  if (!Array.isArray(tombstones) || !tombstones.every((key) => typeof key === 'string')) {
    throw planError('INVALID_PLAN', 'Expected remote tombstones');
  }
  if (typeof resolutions !== 'string' || !/^[LR]{0,200}$/.test(resolutions)) {
    throw planError('INVALID_PLAN', 'Expected conflict resolutions');
  }
  const tombstoneSet = new Set(tombstones);
  const settingChanges = { preferences: [], opencode: [], extensions: [] };
  const fileChanges = [];
  let conflictIndex = 0;
  for (const item of items) {
    if (!item || typeof item !== 'object' || typeof item.key !== 'string' || typeof item.action !== 'string') {
      throw planError('INVALID_PLAN', 'Invalid preview item');
    }
    let applyRemote;
    if (item.action === 'download') applyRemote = true;
    else if (item.action === 'conflict') {
      const resolution = resolutions[conflictIndex++];
      if (resolution !== 'L' && resolution !== 'R') throw planError('INVALID_PLAN', 'Missing conflict resolution');
      applyRemote = resolution === 'R';
    } else if (item.action === 'upload') applyRemote = false;
    else throw planError('INVALID_PLAN', 'Invalid preview action');

    if (!applyRemote) continue;
    const deleted = item.remote?.deleted === true || tombstoneSet.has(item.key);
    const remoteValue = deleted ? undefined : remoteValues[item.key];
    if (!deleted && remoteValue === undefined) throw planError('INVALID_PLAN', 'Remote value is missing for an approved change');
    const change = changeForKey(item, deleted ? 'remove' : 'set', remoteValue);
    if (change.kind === 'file') fileChanges.push(change);
    else settingChanges[change.target].push(change);
  }
  if (conflictIndex !== resolutions.length) throw planError('INVALID_PLAN', 'Unresolved conflict choices remain');

  for (const target of SETTING_TARGET_ORDER) {
    settingChanges[target].sort((left, right) => left.key.localeCompare(right.key));
  }
  fileChanges.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const changeCount = SETTING_TARGET_ORDER.reduce((count, target) => count + settingChanges[target].length, 0)
    + fileChanges.length;
  if (changeCount === 0) throw planError('NOTHING_TO_APPLY', 'The confirmed plan has no changes for this machine');

  return {
    settingChanges,
    fileChanges,
    changeCount,
  };
}
