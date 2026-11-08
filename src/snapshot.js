const PORTABLE_PREFERENCE_FIELDS = new Set([
  'lightThemeId',
  'darkThemeId',
  'notifyOnSubtasks',
  'notifyOnCompletion',
  'notifyOnError',
  'notifyOnQuestion',
  'notificationTemplates',
  'usageDisplayMode',
  'usageDropdownProviders',
  'fileEditorKeymap',
  'timeFormatPreference',
  'weekStartPreference',
  'monoFont',
  'nativeNotificationsEnabled',
  'favoriteModels',
  'recentModels',
  'hiddenModels',
  'collapsedModelProviders',
  'recentAgents',
  'codeBlockLineWrap',
  'recentEfforts',
  'defaultModel',
  'showDeletionDialog',
  'autoSaveEnabled',
  'toolJsonViewMode',
  'sidebarProjectSortOrder',
  'customProviderIcons',
  'favoriteAgents',
  'lastSelectedModel',
  'inputHistoryLimit',
  'lastUsedEfforts',
  'diffLayoutPreference',
  'workStatusPanelEnabled',
  'notifyOnPullRequests',
]);

const SENSITIVE_KEY = /(?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret|credential|authorization|private[-_]?key|client[-_]?secret)/i;
const SENSITIVE_QUERY_KEY = /(?:^|[-_])(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|key|password|passwd|secret|credential|authorization|auth|private[-_]?key|client[-_]?secret)(?:$|[-_])/i;
const NEVER_SYNC_KEYS = new Set(['__proto__', 'prototype', 'constructor', 'auth', 'env', 'headers', 'cookies']);

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sanitizeString(value) {
  if (!/^https?:\/\//i.test(value)) return value;

  try {
    const url = new URL(value);
    let changed = false;
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
      changed = true;
    }
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY.test(key)) {
        url.searchParams.delete(key);
        changed = true;
      }
    }
    return changed ? url.toString() : value;
  } catch {
    return value;
  }
}

function sanitizeValue(value, seen = new WeakSet()) {
  if (typeof value === 'string') return sanitizeString(value);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Config values must be finite JSON numbers');
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('Config values must not contain cycles');
    seen.add(value);
    const result = value.map((item) => sanitizeValue(item, seen));
    seen.delete(value);
    return result;
  }
  if (!isRecord(value)) throw new TypeError('Config values must be JSON-compatible');
  if (seen.has(value)) throw new TypeError('Config values must not contain cycles');
  seen.add(value);

  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (NEVER_SYNC_KEYS.has(key.toLowerCase()) || SENSITIVE_KEY.test(key)) continue;
    result[key] = sanitizeValue(child, seen);
  }
  seen.delete(value);
  return result;
}

export function selectPortablePreferences(preferences) {
  if (!isRecord(preferences)) throw new TypeError('Expected a preferences object');
  if (!isRecord(preferences.fields)) throw new TypeError('Expected a fields object');
  if (!((typeof preferences.version === 'string' && preferences.version.length > 0)
    || (typeof preferences.version === 'number' && Number.isFinite(preferences.version)))) {
    throw new TypeError('Expected a valid preferences version');
  }

  const fields = {};
  for (const key of PORTABLE_PREFERENCE_FIELDS) {
    if (Object.hasOwn(preferences.fields, key)) {
      fields[key] = sanitizeValue(preferences.fields[key]);
    }
  }
  return { version: preferences.version, fields };
}

export function sanitizeOpenCodeConfig(config) {
  if (!isRecord(config)) throw new TypeError('Expected an OpenCode config object');
  return sanitizeValue(config);
}
