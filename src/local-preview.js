import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';

import {
  sanitizeOpenCodeConfig,
  selectExtensionRepositories,
  selectPortablePreferences,
} from './snapshot.js';

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

async function readJsonFile(filePath) {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) return { status: 'unavailable' };
    const text = await handle.readFile('utf8');
    return { status: 'ready', value: JSON.parse(text) };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { status: 'missing' };
    }
    return { status: 'unavailable' };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function sourcePreview(filePath, id, countItems) {
  const read = await readJsonFile(filePath);
  if (read.status !== 'ready') return { id, status: read.status, portableItems: 0 };
  try {
    return { id, status: 'ready', portableItems: countItems(read.value) };
  } catch {
    return { id, status: 'unavailable', portableItems: 0 };
  }
}

export async function createLocalPreview({ openChamberDir, openCodeDir }) {
  if (typeof openChamberDir !== 'string' || typeof openCodeDir !== 'string') {
    throw new TypeError('OpenChamber and OpenCode config directories are required');
  }

  const [preferences, opencode, extensions] = await Promise.all([
    sourcePreview(path.join(openChamberDir, 'preferences.json'), 'preferences', (value) =>
      Object.keys(selectPortablePreferences(value).fields).length),
    sourcePreview(path.join(openCodeDir, 'opencode.json'), 'opencode', (value) =>
      Object.keys(sanitizeOpenCodeConfig(value)).length),
    sourcePreview(path.join(openChamberDir, 'extensions.json'), 'extensions', (value) =>
      selectExtensionRepositories(value).length),
  ]);

  return { sources: [preferences, opencode, extensions] };
}
