import path from 'node:path';

import { readJsonFile } from './local-preview.js';
import { readPortableOpenCodeFiles } from './portable-files.js';
import { sanitizeOpenCodeConfig, selectExtensionRepositories, selectPortablePreferences } from './snapshot.js';

// Encoding each top-level key keeps dots and other JSON key characters unambiguous.
export function openCodeKeyPath(key) {
  if (typeof key !== 'string') throw new TypeError('Invalid OpenCode key');
  const bytes = Buffer.from(key, 'utf8');
  if (bytes.toString('utf8') !== key) throw new TypeError('Invalid OpenCode key');
  return `opencode.k${bytes.toString('base64url')}`;
}

export function decodeOpenCodeKeyPath(keyPath) {
  const match = typeof keyPath === 'string' && keyPath.match(/^opencode\.k([A-Za-z0-9_-]*)$/);
  if (!match || match[1].length > 342) throw new TypeError('Invalid OpenCode key path');
  const bytes = Buffer.from(match[1], 'base64url');
  const key = bytes.toString('utf8');
  if (Buffer.from(key, 'utf8').compare(bytes) !== 0 || bytes.toString('base64url') !== match[1]) {
    throw new TypeError('Invalid OpenCode key path');
  }
  return key;
}

export async function readLocalSnapshot({ openChamberDir, openCodeDir }) {
  if (typeof openChamberDir !== 'string' || typeof openCodeDir !== 'string') {
    throw new TypeError('OpenChamber and OpenCode config directories are required');
  }
  const sources = {};
  const values = {};
  const definitions = [
    ['preferences', path.join(openChamberDir, 'preferences.json'), (input) => {
      const selected = selectPortablePreferences(input);
      return Object.fromEntries(Object.entries(selected.fields).map(([key, value]) => [`preferences.${key}`, value]));
    }],
    ['opencode', path.join(openCodeDir, 'opencode.json'), (input) =>
      Object.fromEntries(Object.entries(sanitizeOpenCodeConfig(input)).map(([key, value]) => [openCodeKeyPath(key), value]))],
    ['extensions', path.join(openChamberDir, 'extensions.json'), (input) =>
      ({ 'extensions.repositories': selectExtensionRepositories(input) })],
  ];
  for (const [id, filePath, select] of definitions) {
    const file = await readJsonFile(filePath);
    if (file.status !== 'ready') {
      sources[id] = { status: file.status };
      continue;
    }
    try {
      const selected = select(file.value);
      Object.assign(values, selected);
      sources[id] = { status: 'ready' };
    } catch {
      sources[id] = { status: 'unavailable' };
    }
  }
  const openCodeFiles = await readPortableOpenCodeFiles(openCodeDir);
  sources['opencode-files'] = { status: openCodeFiles.status };
  if (openCodeFiles.status === 'ready') Object.assign(values, openCodeFiles.values);
  return { sources, values };
}
