import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const MAX_SETTINGS_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PORTABLE_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_PORTABLE_FILE_BYTES = 4 * 1024 * 1024;
const JOURNAL_VERSION = 1;
const MAX_JOURNAL_STEPS = 300;

function applyError(code, message) {
  return Object.assign(new Error(message), { code });
}

function simulatedCrashError() {
  return applyError('SIMULATED_CRASH', 'Simulated interruption');
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function defaultApplyJournalPath(openChamberDir) {
  if (typeof openChamberDir !== 'string') throw new TypeError('OpenChamber config directory is required');
  return path.join(openChamberDir, '.openchamber-sync-apply-journal.json');
}

async function atomicWriteFile(filePath, text, mode) {
  const temp = `${filePath}.${randomBytes(8).toString('hex')}.sync-jtmp`;
  let handle;
  try {
    handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
  try {
    await rename(temp, filePath);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function readSettingsFile(filePath) {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_SETTINGS_FILE_BYTES) {
      throw applyError('APPLY_TARGET_UNAVAILABLE', 'A local settings file is not a readable regular file');
    }
    const text = await handle.readFile('utf8');
    const value = JSON.parse(text);
    if (!isRecord(value)) throw new TypeError('Settings must be a JSON object');
    return { existed: true, mode: info.mode & 0o7777, value };
  } catch (error) {
    if (error?.code === 'APPLY_TARGET_UNAVAILABLE') throw error;
    if (error && typeof error === 'object' && 'code' in error
      && (error.code === 'ENOENT' || error.code === 'ELOOP' || error.code === 'ENOTDIR')) {
      throw applyError('APPLY_TARGET_UNAVAILABLE', 'A local settings file is missing or unsafe to read');
    }
    throw applyError('APPLY_TARGET_UNAVAILABLE', 'A local settings file could not be parsed');
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function serializeTargetFile(filePath) {
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { existed: false };
    throw applyError('APPLY_TARGET_UNAVAILABLE', 'A local target path could not be inspected');
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw applyError('APPLY_TARGET_UNAVAILABLE', 'A local target path is not a regular file');
  }
  return { existed: true, mode: info.mode & 0o7777 };
}

function normalizeHttpsOrigin(url) {
  if (typeof url !== 'string') return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function buildExtensionsContent(base, changes) {
  const change = changes[0];
  const baseOrigins = isRecord(base.gitOrigins) ? base.gitOrigins : {};
  const targetSet = change.type === 'set' ? new Set(change.value) : new Set();
  const origins = {};
  const covered = new Set();
  for (const [key, entry] of Object.entries(baseOrigins)) {
    // Entries that are not plain HTTPS origins stay untouched: they are machine-local.
    const normalized = isRecord(entry) ? normalizeHttpsOrigin(entry.url) : undefined;
    if (!normalized || !targetSet.has(normalized)) {
      if (!normalized) origins[key] = entry;
      continue;
    }
    origins[key] = entry;
    covered.add(normalized);
  }
  if (change.type === 'set') {
    for (const url of [...change.value].sort()) {
      if (covered.has(url)) continue;
      const parsed = new URL(url);
      const base2 = `${parsed.hostname}${parsed.pathname}${parsed.search}`
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'extension';
      let key = base2;
      for (let suffix = 2; Object.hasOwn(origins, key); suffix += 1) key = `${base2}-${suffix}`;
      origins[key] = { url };
    }
  }
  const content = { ...base, gitOrigins: origins };
  return content;
}

function buildSettingsContent(target, base, changes) {
  const content = JSON.parse(JSON.stringify(base));
  if (target === 'preferences') {
    if (content.fields !== undefined && !isRecord(content.fields)) {
      throw applyError('APPLY_TARGET_UNAVAILABLE', 'Local preferences fields are not an object');
    }
    if (!isRecord(content.fields)) content.fields = {};
    for (const change of changes) {
      if (change.type === 'set') content.fields[change.key] = change.value;
      else delete content.fields[change.key];
    }
    return content;
  }
  if (target === 'opencode') {
    for (const change of changes) {
      if (change.type === 'set') content[change.key] = change.value;
      else delete content[change.key];
    }
    return content;
  }
  return buildExtensionsContent(base, changes);
}

function settingsTargetPath(target, { openChamberDir, openCodeDir }) {
  if (target === 'preferences') return path.join(openChamberDir, 'preferences.json');
  if (target === 'extensions') return path.join(openChamberDir, 'extensions.json');
  return path.join(openCodeDir, 'opencode.json');
}

async function ensureFileDirectory(openCodeDir, relativePath) {
  const rootInfo = await lstat(openCodeDir).catch((error) => {
    throw applyError('APPLY_TARGET_UNAVAILABLE', 'The OpenCode configuration directory is unavailable');
  });
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw applyError('APPLY_TARGET_UNAVAILABLE', 'The OpenCode configuration directory is unavailable');
  }
  const createdDirs = [];
  let current = openCodeDir;
  for (const part of relativePath.split('/').slice(0, -1)) {
    const next = path.join(current, part);
    let info;
    try {
      info = await lstat(next);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw applyError('APPLY_TARGET_UNAVAILABLE', 'A local target directory could not be inspected');
      }
      await mkdir(next);
      createdDirs.push(next);
      info = await lstat(next);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw applyError('APPLY_TARGET_UNAVAILABLE', 'A local target directory is not a real directory');
    }
    current = next;
  }
  return { directory: current, createdDirs };
}

async function backupTarget(step) {
  try {
    await link(step.absolutePath, step.backup);
    return;
  } catch {
    // Fall through to a bounded manual copy for filesystems without hard links.
  }
  let handle;
  try {
    handle = await open(step.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_SETTINGS_FILE_BYTES) {
      throw applyError('APPLY_TARGET_UNAVAILABLE', 'A local target file could not be backed up');
    }
    const text = await handle.readFile('utf8');
    await atomicWriteFile(step.backup, text, info.mode & 0o7777);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function buildSteps(plan, { openChamberDir, openCodeDir }) {
  const steps = [];
  for (const target of ['preferences', 'opencode', 'extensions']) {
    const changes = plan.settingChanges[target];
    if (!changes || changes.length === 0) continue;
    steps.push({
      kind: 'settings',
      target,
      type: 'write',
      changes,
      absolutePath: settingsTargetPath(target, { openChamberDir, openCodeDir }),
    });
  }
  for (const change of plan.fileChanges) {
    const absolutePath = path.join(openCodeDir, change.relativePath);
    if (path.relative(openCodeDir, absolutePath).startsWith('..') || path.isAbsolute(path.relative(openCodeDir, absolutePath))) {
      throw applyError('APPLY_TARGET_UNAVAILABLE', 'A portable file target escapes the OpenCode directory');
    }
    steps.push({
      kind: 'file',
      target: change.target,
      relativePath: change.relativePath,
      type: change.type,
      text: change.text,
      absolutePath,
    });
  }
  steps.sort((left, right) => left.absolutePath.localeCompare(right.absolutePath));
  if (steps.length > MAX_JOURNAL_STEPS) throw applyError('APPLY_LIMIT_EXCEEDED', 'The plan exceeds the supported number of file changes');
  return steps;
}

function journalDocument(planId, steps) {
  return {
    version: JOURNAL_VERSION,
    planId,
    steps: steps.map((step, index) => ({
      id: index,
      target: step.absolutePath,
      kind: step.kind,
      type: step.type,
      temp: step.temp ?? null,
      backup: step.backup ?? null,
      created: step.created === true,
      createdDirs: step.createdDirs ?? [],
      resultHash: step.resultHash ?? null,
      status: step.status ?? 'prepared',
    })),
  };
}

function validateJournalDocument(value) {
  if (!isRecord(value) || value.version !== JOURNAL_VERSION
    || typeof value.planId !== 'string' || !/^[a-f0-9]{64}$/.test(value.planId)
    || !Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > MAX_JOURNAL_STEPS) {
    throw applyError('APPLY_JOURNAL_INVALID', 'The apply recovery marker is invalid');
  }
  for (const step of value.steps) {
    if (!isRecord(step) || !Number.isSafeInteger(step.id) || step.id < 0 || step.id >= value.steps.length
      || typeof step.target !== 'string' || !path.isAbsolute(step.target) || step.target.length > 1200
      || !['settings', 'file'].includes(step.kind)
      || !['write', 'delete'].includes(step.type)
      || (step.temp !== null && (typeof step.temp !== 'string' || !path.isAbsolute(step.temp)))
      || (step.backup !== null && (typeof step.backup !== 'string' || !path.isAbsolute(step.backup)))
      || typeof step.created !== 'boolean'
      || !Array.isArray(step.createdDirs) || step.createdDirs.length > 64
        || step.createdDirs.some((dir) => typeof dir !== 'string' || !path.isAbsolute(dir))
      || (step.resultHash !== null && (typeof step.resultHash !== 'string' || !/^[a-f0-9]{64}$/.test(step.resultHash)))
      || !['prepared', 'done'].includes(step.status)) {
      throw applyError('APPLY_JOURNAL_INVALID', 'The apply recovery marker is invalid');
    }
  }
  return value;
}

async function readJournalFile(journalPath) {
  let handle;
  try {
    handle = await open(journalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1024 * 1024) {
      throw applyError('APPLY_JOURNAL_INVALID', 'The apply recovery marker is invalid');
    }
    const text = await handle.readFile('utf8');
    return validateJournalDocument(JSON.parse(text));
  } catch (error) {
    if (error?.code === 'APPLY_JOURNAL_INVALID') throw error;
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw applyError('APPLY_JOURNAL_INVALID', 'The apply recovery marker is invalid');
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function hashTargetIfFile(filePath) {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_SETTINGS_FILE_BYTES) return undefined;
    const text = await handle.readFile('utf8');
    return sha256Text(text);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function recoverApplyJournal({ journalPath }) {
  if (typeof journalPath !== 'string') throw new TypeError('A journal path is required');
  const journal = await readJournalFile(journalPath);
  if (!journal) return { recovered: false };
  let rolledBack = 0;
  for (const step of [...journal.steps].reverse()) {
    if (step.backup) {
      const hash = await hashTargetIfFile(step.target);
      // Only restore when the target still holds what this apply wrote; a
      // later user edit must never be overwritten by recovery.
      if (hash === null || hash === step.resultHash) {
        // A missing backup (target vanished between plan and write) is a no-op.
        await rename(step.backup, step.target).catch((error) => {
          if (error?.code === 'ENOENT') return;
          throw error;
        });
      }
    } else if (step.created && step.type === 'write') {
      const hash = await hashTargetIfFile(step.target);
      if (hash === null || hash === step.resultHash) {
        await rm(step.target, { force: true }).catch(() => {});
      }
    }
    if (step.temp) await rm(step.temp, { force: true }).catch(() => {});
    for (const dir of [...(step.createdDirs ?? [])].reverse()) {
      await rm(dir, { force: true }).catch(() => {});
    }
    rolledBack += 1;
  }
  await rm(journalPath, { force: true }).catch(() => {});
  return { recovered: true, rolledBack };
}

async function writeStep(step) {
  if (step.type === 'delete') {
    if (step.existed) await backupTarget(step);
    await rm(step.absolutePath, { force: false }).catch((error) => {
      if (error?.code === 'ENOENT') return;
      throw applyError('APPLY_TARGET_UNAVAILABLE', 'A local file could not be removed');
    });
    return;
  }
  const temp = `${step.absolutePath}.sync-tmp-${randomBytes(8).toString('hex')}`;
  const mode = step.existed ? step.mode : 0o600;
  let handle;
  try {
    handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
    await handle.writeFile(step.newText, 'utf8');
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
  step.temp = temp;
  if (step.existed) await backupTarget(step);
  await rename(temp, step.absolutePath);
}

export async function applyPlanToFiles(plan, {
  openChamberDir,
  openCodeDir,
  journalPath,
  planId,
  crashAfterSteps,
  crashPhase,
} = {}) {
  if (typeof openChamberDir !== 'string' || typeof openCodeDir !== 'string') {
    throw new TypeError('OpenChamber and OpenCode config directories are required');
  }
  if (typeof planId !== 'string' || !/^[a-f0-9]{64}$/.test(planId)) throw new TypeError('A plan digest is required');
  if (journalPath === undefined) journalPath = defaultApplyJournalPath(openChamberDir);
  if (typeof journalPath !== 'string') throw new TypeError('A journal path is required');

  const existing = await readJournalFile(journalPath).catch((error) => {
    if (error?.code === 'APPLY_JOURNAL_INVALID') throw error;
    throw applyError('APPLY_JOURNAL_INVALID', 'The apply recovery marker is invalid');
  });
  const recovery = existing ? await recoverApplyJournal({ journalPath }) : { recovered: false };

  const steps = buildSteps(plan, { openChamberDir, openCodeDir });

  // Read phase: nothing is written until every target has been read and the
  // merged content for every step has been computed.
  let totalFileBytes = 0;
  for (const step of steps) {
    if (step.kind === 'settings') {
      const read = await readSettingsFile(step.absolutePath);
      step.existed = read.existed;
      step.mode = read.mode;
      const content = buildSettingsContent(step.target, read.value, step.changes);
      step.newText = `${JSON.stringify(content, null, 2)}\n`;
    } else if (step.type === 'write') {
      const { directory, createdDirs } = await ensureFileDirectory(openCodeDir, step.relativePath);
      step.createdDirs = createdDirs;
      const serialized = await serializeTargetFile(step.absolutePath);
      step.existed = serialized.existed;
      step.mode = serialized.mode;
      const bytes = Buffer.byteLength(step.text, 'utf8');
      if (bytes > MAX_PORTABLE_FILE_BYTES) throw applyError('APPLY_LIMIT_EXCEEDED', 'A portable file exceeds the size limit');
      totalFileBytes += bytes;
      if (totalFileBytes > MAX_TOTAL_PORTABLE_FILE_BYTES) {
        throw applyError('APPLY_LIMIT_EXCEEDED', 'Portable files exceed the total size limit');
      }
      step.newText = step.text;
    } else {
      const serialized = await serializeTargetFile(step.absolutePath);
      step.existed = serialized.existed;
    }
    step.resultHash = step.type === 'write' ? sha256Text(step.newText) : null;
    step.created = step.type === 'write' && !step.existed;
  }

  // Journal phase: the marker lists every step before any file is modified.
  for (const step of steps) {
    if (step.type === 'write') {
      step.temp = `${step.absolutePath}.sync-tmp-${randomBytes(8).toString('hex')}`;
    }
    step.backup = step.existed ? `${step.absolutePath}.sync-backup-${randomBytes(8).toString('hex')}` : null;
    step.status = 'prepared';
  }
  await atomicWriteFile(journalPath, `${JSON.stringify(journalDocument(planId, steps), null, 2)}\n`, 0o600);
  if (crashPhase === 'journal') throw simulatedCrashError();

  // Write phase: each step is atomic and recorded before the next starts.
  let completed = 0;
  for (const step of steps) {
    await writeStep(step);
    step.status = 'done';
    await atomicWriteFile(journalPath, `${JSON.stringify(journalDocument(planId, steps), null, 2)}\n`, 0o600);
    completed += 1;
    if (crashPhase === 'write' && Number.isInteger(crashAfterSteps) && completed >= crashAfterSteps) {
      throw simulatedCrashError();
    }
  }

  // Cleanup phase: backups and the marker are removed only after every step.
  if (crashPhase === 'cleanup') throw simulatedCrashError();
  for (const step of steps) {
    if (step.backup) await rm(step.backup, { force: true }).catch(() => {});
    if (step.temp) await rm(step.temp, { force: true }).catch(() => {});
  }
  await rm(journalPath, { force: true }).catch(() => {});
  return { applied: completed, recovered: recovery.recovered === true };
}
