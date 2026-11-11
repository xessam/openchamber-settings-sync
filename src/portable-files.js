import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { containsCredentialMarker } from './credential-scan.js';

const PORTABLE_DIRECTORIES = new Set(['agents', 'commands', 'skills', 'plugins']);
const PORTABLE_EXTENSIONS = new Set([
  '.cjs', '.js', '.json', '.jsonc', '.md', '.mdc', '.mjs', '.toml', '.ts', '.txt', '.yaml', '.yml',
]);
const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules']);
const SENSITIVE_FILENAME = /(?:^|[._-])(?:auth|api[-_]?keys?|access[-_]?tokens?|refresh[-_]?tokens?|credential|credentials|identity|private[-_]?keys?|passwords?|passwds?|secret|secrets|tokens?)(?:[._-]|$)/i;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 256;
const MAX_DIRECTORY_ENTRIES = 4096;
const MAX_DEPTH = 12;

function encodeFileKey(relativePath) {
  if (Buffer.from(relativePath, 'utf8').toString('utf8') !== relativePath) {
    throw new TypeError('OpenCode file path is not valid UTF-8');
  }
  return `opencodeFile.k${Buffer.from(relativePath, 'utf8').toString('base64url')}`;
}

export function decodePortableFileKey(keyPath) {
  const match = typeof keyPath === 'string' && keyPath.match(/^opencodeFile\.k([A-Za-z0-9_-]+)$/);
  if (!match || match[1].length > 684) throw new TypeError('Invalid portable file key');
  const bytes = Buffer.from(match[1], 'base64url');
  const relativePath = bytes.toString('utf8');
  if (bytes.length > 512 || Buffer.from(relativePath, 'utf8').compare(bytes) !== 0 || bytes.toString('base64url') !== match[1]
    || path.posix.isAbsolute(relativePath) || path.posix.normalize(relativePath) !== relativePath
    || relativePath.includes('\\')) {
    throw new TypeError('Invalid portable file path');
  }
  const parts = relativePath.split('/');
  if (parts.length < 2 || !PORTABLE_DIRECTORIES.has(parts[0])
    || parts.some((part, index) => !part || part === '.' || part === '..' || EXCLUDED_DIRECTORIES.has(part)
      || (index < parts.length - 1 && SENSITIVE_FILENAME.test(part)))
    || !PORTABLE_EXTENSIONS.has(path.posix.extname(parts.at(-1)).toLowerCase())
    || SENSITIVE_FILENAME.test(parts.at(-1))) {
    throw new TypeError('Unsupported portable file path');
  }
  return relativePath;
}

async function readPortableTextFile(filePath) {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new TypeError('OpenCode file is not portable');
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > MAX_FILE_BYTES) throw new TypeError('OpenCode file is not portable');
    const bytes = buffer.subarray(0, bytesRead);
    const text = bytes.toString('utf8');
    if (text.includes('\0') || !Buffer.from(text, 'utf8').equals(bytes) || containsCredentialMarker(text)) {
      throw new TypeError('OpenCode file is not portable');
    }
    return { text, bytes: bytes.length };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function walkPortableDirectory(directoryPath, relativeDirectory, depth, result) {
  if (depth > MAX_DEPTH) throw new TypeError('OpenCode directory is too deep');
  const entries = await readdir(directoryPath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (++result.entries > MAX_DIRECTORY_ENTRIES) throw new TypeError('Too many OpenCode directory entries');
    if (entry.name === '.' || entry.name === '..') throw new TypeError('Invalid OpenCode file name');
    if (entry.isSymbolicLink()) throw new TypeError('OpenCode symlinks are not portable');
    const filePath = path.join(directoryPath, entry.name);
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      if (SENSITIVE_FILENAME.test(entry.name)) throw new TypeError('Credential-named OpenCode directory is not portable');
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
        await walkPortableDirectory(filePath, relativePath, depth + 1, result);
      }
      continue;
    }
    if (!entry.isFile() || !PORTABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    if (SENSITIVE_FILENAME.test(entry.name)) throw new TypeError('Credential-named OpenCode file is not portable');
    if (++result.files > MAX_FILES) throw new TypeError('Too many OpenCode files');
    const { text, bytes } = await readPortableTextFile(filePath);
    result.bytes += bytes;
    if (result.bytes > MAX_TOTAL_BYTES) throw new TypeError('OpenCode files exceed the portable size limit');
    result.values[encodeFileKey(relativePath)] = text;
  }
}

export async function readPortableOpenCodeFiles(openCodeDir) {
  if (typeof openCodeDir !== 'string') throw new TypeError('OpenCode config directory is required');
  let rootInfo;
  try {
    rootInfo = await lstat(openCodeDir);
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'missing', values: {} };
    return { status: 'unavailable', values: {} };
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return { status: 'unavailable', values: {} };

  const result = { entries: 0, files: 0, bytes: 0, values: {} };
  try {
    for (const directory of PORTABLE_DIRECTORIES) {
      const directoryPath = path.join(openCodeDir, directory);
      let info;
      try {
        info = await lstat(directoryPath);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      if (info.isSymbolicLink() || !info.isDirectory()) throw new TypeError('OpenCode source is not a directory');
      await walkPortableDirectory(directoryPath, directory, 0, result);
    }
    return { status: 'ready', values: result.values };
  } catch {
    return { status: 'unavailable', values: {} };
  }
}
