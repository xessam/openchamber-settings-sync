// src/service-entry.js
import { homedir } from "node:os";
import path7 from "node:path";

// src/service.js
import http from "node:http";
import { createHash as createHash2, createHmac, randomBytes as randomBytes2 } from "node:crypto";

// src/apply-plan.js
import { Buffer as Buffer2 } from "node:buffer";

// src/credential-scan.js
var CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/i,
  /\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|passwd|secret|credential|authorization|private[-_ ]?key|client[-_ ]?secret)\b["']?\s*[:=]\s*["']?\S+/i,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/i,
  /https?:\/\/[^\s/@:]+:[^\s/@]+@/i,
  /[?&](?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|key|password|passwd|secret|credential|authorization|auth|private[-_]?key|client[-_]?secret)=([^&#\s]+)/i,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|npm_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|(?:sk|rk)_live_[A-Za-z0-9]{16,})\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/
];
function containsCredentialMarker(text) {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text));
}

// src/local-snapshot.js
import path3 from "node:path";

// src/local-preview.js
import { constants as constants2 } from "node:fs";
import { open as open2 } from "node:fs/promises";
import path2 from "node:path";

// src/snapshot.js
var PORTABLE_PREFERENCE_FIELDS = /* @__PURE__ */ new Set([
  "lightThemeId",
  "darkThemeId",
  "notifyOnSubtasks",
  "notifyOnCompletion",
  "notifyOnError",
  "notifyOnQuestion",
  "notificationTemplates",
  "usageDisplayMode",
  "usageDropdownProviders",
  "fileEditorKeymap",
  "timeFormatPreference",
  "weekStartPreference",
  "monoFont",
  "nativeNotificationsEnabled",
  "favoriteModels",
  "recentModels",
  "hiddenModels",
  "collapsedModelProviders",
  "recentAgents",
  "codeBlockLineWrap",
  "recentEfforts",
  "defaultModel",
  "showDeletionDialog",
  "autoSaveEnabled",
  "toolJsonViewMode",
  "sidebarProjectSortOrder",
  "customProviderIcons",
  "favoriteAgents",
  "lastSelectedModel",
  "inputHistoryLimit",
  "lastUsedEfforts",
  "diffLayoutPreference",
  "workStatusPanelEnabled",
  "notifyOnPullRequests"
]);
var SENSITIVE_KEY = /(?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret|credential|authorization|private[-_]?key|client[-_]?secret)/i;
var SENSITIVE_QUERY_KEY = /(?:^|[-_])(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|key|password|passwd|secret|credential|authorization|auth|private[-_]?key|client[-_]?secret)(?:$|[-_])/i;
var NEVER_SYNC_KEYS = /* @__PURE__ */ new Set(["__proto__", "prototype", "constructor", "auth", "env", "headers", "cookies"]);
function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function sanitizeString(value) {
  let sanitized = value;
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      let changed = false;
      if (url.username || url.password) {
        url.username = "";
        url.password = "";
        changed = true;
      }
      for (const key of [...url.searchParams.keys()]) {
        if (SENSITIVE_QUERY_KEY.test(key)) {
          url.searchParams.delete(key);
          changed = true;
        }
      }
      sanitized = changed ? url.toString() : value;
    } catch {
      sanitized = value;
    }
  }
  if (containsCredentialMarker(sanitized)) throw new TypeError("Config contains credential-like text");
  return sanitized;
}
function sanitizeValue(value, seen = /* @__PURE__ */ new WeakSet()) {
  if (typeof value === "string") return sanitizeString(value);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Config values must be finite JSON numbers");
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Config values must not contain cycles");
    seen.add(value);
    const result2 = value.map((item) => sanitizeValue(item, seen));
    seen.delete(value);
    return result2;
  }
  if (!isRecord(value)) throw new TypeError("Config values must be JSON-compatible");
  if (seen.has(value)) throw new TypeError("Config values must not contain cycles");
  seen.add(value);
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (NEVER_SYNC_KEYS.has(key.toLowerCase()) || SENSITIVE_KEY.test(key)) continue;
    result[key] = sanitizeValue(child, seen);
  }
  seen.delete(value);
  return result;
}
function selectPortablePreferences(preferences) {
  if (!isRecord(preferences)) throw new TypeError("Expected a preferences object");
  if (!isRecord(preferences.fields)) throw new TypeError("Expected a fields object");
  if (!(typeof preferences.version === "string" && preferences.version.length > 0 || typeof preferences.version === "number" && Number.isFinite(preferences.version))) {
    throw new TypeError("Expected a valid preferences version");
  }
  const fields = {};
  for (const key of PORTABLE_PREFERENCE_FIELDS) {
    if (Object.hasOwn(preferences.fields, key)) {
      fields[key] = sanitizeValue(preferences.fields[key]);
    }
  }
  return { version: preferences.version, fields };
}
function isPortablePreferenceField(key) {
  return PORTABLE_PREFERENCE_FIELDS.has(key);
}
function isPortableOpenCodeConfigKey(key) {
  return typeof key === "string" && !NEVER_SYNC_KEYS.has(key.toLowerCase()) && !SENSITIVE_KEY.test(key);
}
function sanitizeOpenCodeConfig(config) {
  if (!isRecord(config)) throw new TypeError("Expected an OpenCode config object");
  return sanitizeValue(config);
}
function selectExtensionRepositories(extensionConfig) {
  if (!isRecord(extensionConfig)) throw new TypeError("Expected an extension config object");
  if (!isRecord(extensionConfig.gitOrigins)) return [];
  const repositories = /* @__PURE__ */ new Set();
  for (const origin of Object.values(extensionConfig.gitOrigins)) {
    if (!isRecord(origin) || typeof origin.url !== "string") continue;
    const sanitized = sanitizeString(origin.url);
    try {
      const url = new URL(sanitized);
      if (url.protocol === "https:" && url.hostname) repositories.add(url.toString());
    } catch {
    }
  }
  return [...repositories].sort();
}

// src/portable-files.js
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
var PORTABLE_DIRECTORIES = /* @__PURE__ */ new Set(["agents", "commands", "skills", "plugins"]);
var PORTABLE_EXTENSIONS = /* @__PURE__ */ new Set([
  ".cjs",
  ".js",
  ".json",
  ".jsonc",
  ".md",
  ".mdc",
  ".mjs",
  ".toml",
  ".ts",
  ".txt",
  ".yaml",
  ".yml"
]);
var EXCLUDED_DIRECTORIES = /* @__PURE__ */ new Set([".git", "node_modules"]);
var SENSITIVE_FILENAME = /(?:^|[._-])(?:auth|api[-_]?keys?|access[-_]?tokens?|refresh[-_]?tokens?|credential|credentials|identity|private[-_]?keys?|passwords?|passwds?|secret|secrets|tokens?)(?:[._-]|$)/i;
var MAX_FILE_BYTES = 512 * 1024;
var MAX_TOTAL_BYTES = 4 * 1024 * 1024;
var MAX_FILES = 256;
var MAX_DIRECTORY_ENTRIES = 4096;
var MAX_DEPTH = 12;
function encodeFileKey(relativePath) {
  if (Buffer.from(relativePath, "utf8").toString("utf8") !== relativePath) {
    throw new TypeError("OpenCode file path is not valid UTF-8");
  }
  return `opencodeFile.k${Buffer.from(relativePath, "utf8").toString("base64url")}`;
}
function decodePortableFileKey(keyPath) {
  const match = typeof keyPath === "string" && keyPath.match(/^opencodeFile\.k([A-Za-z0-9_-]+)$/);
  if (!match || match[1].length > 684) throw new TypeError("Invalid portable file key");
  const bytes = Buffer.from(match[1], "base64url");
  const relativePath = bytes.toString("utf8");
  if (bytes.length > 512 || Buffer.from(relativePath, "utf8").compare(bytes) !== 0 || bytes.toString("base64url") !== match[1] || path.posix.isAbsolute(relativePath) || path.posix.normalize(relativePath) !== relativePath || relativePath.includes("\\")) {
    throw new TypeError("Invalid portable file path");
  }
  const parts = relativePath.split("/");
  if (parts.length < 2 || !PORTABLE_DIRECTORIES.has(parts[0]) || parts.some((part, index) => !part || part === "." || part === ".." || EXCLUDED_DIRECTORIES.has(part) || index < parts.length - 1 && SENSITIVE_FILENAME.test(part)) || !PORTABLE_EXTENSIONS.has(path.posix.extname(parts.at(-1)).toLowerCase()) || SENSITIVE_FILENAME.test(parts.at(-1))) {
    throw new TypeError("Unsupported portable file path");
  }
  return relativePath;
}
async function readPortableTextFile(filePath) {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new TypeError("OpenCode file is not portable");
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > MAX_FILE_BYTES) throw new TypeError("OpenCode file is not portable");
    const bytes = buffer.subarray(0, bytesRead);
    const text = bytes.toString("utf8");
    if (text.includes("\0") || !Buffer.from(text, "utf8").equals(bytes) || containsCredentialMarker(text)) {
      throw new TypeError("OpenCode file is not portable");
    }
    return { text, bytes: bytes.length };
  } finally {
    await handle?.close().catch(() => {
    });
  }
}
async function walkPortableDirectory(directoryPath, relativeDirectory, depth, result) {
  if (depth > MAX_DEPTH) throw new TypeError("OpenCode directory is too deep");
  const entries = await readdir(directoryPath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (++result.entries > MAX_DIRECTORY_ENTRIES) throw new TypeError("Too many OpenCode directory entries");
    if (entry.name === "." || entry.name === "..") throw new TypeError("Invalid OpenCode file name");
    if (entry.isSymbolicLink()) throw new TypeError("OpenCode symlinks are not portable");
    const filePath = path.join(directoryPath, entry.name);
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      if (SENSITIVE_FILENAME.test(entry.name)) throw new TypeError("Credential-named OpenCode directory is not portable");
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
        await walkPortableDirectory(filePath, relativePath, depth + 1, result);
      }
      continue;
    }
    if (!entry.isFile() || !PORTABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    if (SENSITIVE_FILENAME.test(entry.name)) throw new TypeError("Credential-named OpenCode file is not portable");
    if (++result.files > MAX_FILES) throw new TypeError("Too many OpenCode files");
    const { text, bytes } = await readPortableTextFile(filePath);
    result.bytes += bytes;
    if (result.bytes > MAX_TOTAL_BYTES) throw new TypeError("OpenCode files exceed the portable size limit");
    result.values[encodeFileKey(relativePath)] = text;
  }
}
async function readPortableOpenCodeFiles(openCodeDir2) {
  if (typeof openCodeDir2 !== "string") throw new TypeError("OpenCode config directory is required");
  let rootInfo;
  try {
    rootInfo = await lstat(openCodeDir2);
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing", values: {} };
    return { status: "unavailable", values: {} };
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return { status: "unavailable", values: {} };
  const result = { entries: 0, files: 0, bytes: 0, values: {} };
  try {
    for (const directory of PORTABLE_DIRECTORIES) {
      const directoryPath = path.join(openCodeDir2, directory);
      let info;
      try {
        info = await lstat(directoryPath);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      if (info.isSymbolicLink() || !info.isDirectory()) throw new TypeError("OpenCode source is not a directory");
      await walkPortableDirectory(directoryPath, directory, 0, result);
    }
    return { status: "ready", values: result.values };
  } catch {
    return { status: "unavailable", values: {} };
  }
}

// src/local-preview.js
var MAX_CONFIG_BYTES = 2 * 1024 * 1024;
async function readJsonFile(filePath) {
  let handle;
  try {
    handle = await open2(filePath, constants2.O_RDONLY | (constants2.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) return { status: "unavailable" };
    const text = await handle.readFile("utf8");
    return { status: "ready", value: JSON.parse(text) };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { status: "missing" };
    }
    return { status: "unavailable" };
  } finally {
    await handle?.close().catch(() => {
    });
  }
}
async function sourcePreview(filePath, id, countItems) {
  const read = await readJsonFile(filePath);
  if (read.status !== "ready") return { id, status: read.status, portableItems: 0 };
  try {
    return { id, status: "ready", portableItems: countItems(read.value) };
  } catch {
    return { id, status: "unavailable", portableItems: 0 };
  }
}
async function createLocalPreview({ openChamberDir: openChamberDir2, openCodeDir: openCodeDir2 }) {
  if (typeof openChamberDir2 !== "string" || typeof openCodeDir2 !== "string") {
    throw new TypeError("OpenChamber and OpenCode config directories are required");
  }
  const [preferences, opencode, extensions, opencodeFiles] = await Promise.all([
    sourcePreview(path2.join(openChamberDir2, "preferences.json"), "preferences", (value) => Object.keys(selectPortablePreferences(value).fields).length),
    sourcePreview(path2.join(openCodeDir2, "opencode.json"), "opencode", (value) => Object.keys(sanitizeOpenCodeConfig(value)).length),
    sourcePreview(path2.join(openChamberDir2, "extensions.json"), "extensions", (value) => selectExtensionRepositories(value).length),
    readPortableOpenCodeFiles(openCodeDir2).then((files) => ({
      id: "opencode-files",
      status: files.status,
      portableItems: files.status === "ready" ? Object.keys(files.values).length : 0
    }))
  ]);
  return { sources: [preferences, opencode, opencodeFiles, extensions] };
}

// src/local-snapshot.js
function openCodeKeyPath(key) {
  if (typeof key !== "string") throw new TypeError("Invalid OpenCode key");
  const bytes = Buffer.from(key, "utf8");
  if (bytes.toString("utf8") !== key) throw new TypeError("Invalid OpenCode key");
  return `opencode.k${bytes.toString("base64url")}`;
}
function decodeOpenCodeKeyPath(keyPath) {
  const match = typeof keyPath === "string" && keyPath.match(/^opencode\.k([A-Za-z0-9_-]*)$/);
  if (!match || match[1].length > 342) throw new TypeError("Invalid OpenCode key path");
  const bytes = Buffer.from(match[1], "base64url");
  const key = bytes.toString("utf8");
  if (Buffer.from(key, "utf8").compare(bytes) !== 0 || bytes.toString("base64url") !== match[1]) {
    throw new TypeError("Invalid OpenCode key path");
  }
  return key;
}
async function readLocalSnapshot({ openChamberDir: openChamberDir2, openCodeDir: openCodeDir2 }) {
  if (typeof openChamberDir2 !== "string" || typeof openCodeDir2 !== "string") {
    throw new TypeError("OpenChamber and OpenCode config directories are required");
  }
  const sources = {};
  const values = {};
  const definitions = [
    ["preferences", path3.join(openChamberDir2, "preferences.json"), (input) => {
      const selected = selectPortablePreferences(input);
      return Object.fromEntries(Object.entries(selected.fields).map(([key, value]) => [`preferences.${key}`, value]));
    }],
    ["opencode", path3.join(openCodeDir2, "opencode.json"), (input) => Object.fromEntries(Object.entries(sanitizeOpenCodeConfig(input)).map(([key, value]) => [openCodeKeyPath(key), value]))],
    ["extensions", path3.join(openChamberDir2, "extensions.json"), (input) => ({ "extensions.repositories": selectExtensionRepositories(input) })]
  ];
  for (const [id, filePath, select] of definitions) {
    const file = await readJsonFile(filePath);
    if (file.status !== "ready") {
      sources[id] = { status: file.status };
      continue;
    }
    try {
      const selected = select(file.value);
      Object.assign(values, selected);
      sources[id] = { status: "ready" };
    } catch {
      sources[id] = { status: "unavailable" };
    }
  }
  const openCodeFiles = await readPortableOpenCodeFiles(openCodeDir2);
  sources["opencode-files"] = { status: openCodeFiles.status };
  if (openCodeFiles.status === "ready") Object.assign(values, openCodeFiles.values);
  return { sources, values };
}

// src/state.js
var MACHINE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
var KEY_PATH = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*){0,8}$/;
var BLOCKED_SEGMENTS = /* @__PURE__ */ new Set(["__proto__", "constructor", "prototype"]);
var STATE_KEYS = /* @__PURE__ */ new Set(["version", "machineId", "sequence", "entries"]);
function isRecord2(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function isValidMachineId(machineId) {
  return typeof machineId === "string" && MACHINE_ID.test(machineId);
}
function assertMachineId(machineId) {
  if (!isValidMachineId(machineId)) {
    throw new TypeError("Invalid machine id");
  }
}
function assertKeyPath(keyPath) {
  if (typeof keyPath !== "string" || !KEY_PATH.test(keyPath) || keyPath.split(".").some((segment) => BLOCKED_SEGMENTS.has(segment.toLowerCase()))) {
    throw new TypeError("Invalid sync key path");
  }
}
function canonicalize(value, seen = /* @__PURE__ */ new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Sync values must not contain cycles");
    seen.add(value);
    const result2 = value.map((item) => canonicalize(item, seen));
    seen.delete(value);
    return result2;
  }
  if (!isRecord2(value)) throw new TypeError("Sync values must be JSON-compatible");
  if (seen.has(value)) throw new TypeError("Sync values must not contain cycles");
  seen.add(value);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (BLOCKED_SEGMENTS.has(key.toLowerCase())) throw new TypeError("Unsafe sync value key");
    result[key] = canonicalize(value[key], seen);
  }
  seen.delete(value);
  return result;
}
function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}
function validateMachineState(state) {
  if (!isRecord2(state) || state.version !== 1 || !isRecord2(state.entries) || !Number.isSafeInteger(state.sequence) || state.sequence < 0) {
    throw new TypeError("Invalid machine state");
  }
  if (Object.keys(state).some((key) => !STATE_KEYS.has(key))) {
    throw new TypeError("Invalid machine state");
  }
  assertMachineId(state.machineId);
  for (const [keyPath, entry] of Object.entries(state.entries)) {
    assertKeyPath(keyPath);
    if (!isRecord2(entry) || !Number.isSafeInteger(entry.timestamp) || entry.timestamp < 0 || !Number.isSafeInteger(entry.sequence) || entry.sequence < 1 || entry.sequence > state.sequence) {
      throw new TypeError("Invalid machine state entry");
    }
    const allowedKeys = /* @__PURE__ */ new Set(["timestamp", "sequence", "deleted", "value"]);
    if (Object.keys(entry).some((key) => !allowedKeys.has(key))) {
      throw new TypeError("Invalid machine state entry");
    }
    if (entry.deleted === true) {
      if (Object.hasOwn(entry, "value")) throw new TypeError("Invalid machine state tombstone");
    } else if (entry.deleted !== void 0 || !Object.hasOwn(entry, "value")) {
      throw new TypeError("Invalid machine state value");
    } else {
      canonicalize(entry.value);
    }
  }
  return state;
}
function createMachineState({ machineId, previous, values, now = Date.now() }) {
  assertMachineId(machineId);
  if (!isRecord2(values)) throw new TypeError("Expected sync values object");
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("Invalid sync timestamp");
  const oldState = previous === void 0 ? void 0 : validateMachineState(previous);
  if (oldState && oldState.machineId !== machineId) throw new TypeError("Machine state belongs to another machine");
  const cleanValues = {};
  for (const [keyPath, value] of Object.entries(values)) {
    assertKeyPath(keyPath);
    cleanValues[keyPath] = canonicalize(value);
  }
  const entries = { ...oldState?.entries ?? {} };
  let sequence = oldState?.sequence ?? 0;
  const nextSequence = () => {
    if (!Number.isSafeInteger(sequence + 1)) throw new RangeError("Machine state sequence exhausted");
    sequence += 1;
    return sequence;
  };
  for (const [keyPath, value] of Object.entries(cleanValues)) {
    const oldEntry = entries[keyPath];
    if (oldEntry && oldEntry.deleted !== true && stableJson(oldEntry.value) === stableJson(value)) continue;
    entries[keyPath] = { timestamp: now, sequence: nextSequence(), value };
  }
  for (const [keyPath, oldEntry] of Object.entries(entries)) {
    if (!Object.hasOwn(cleanValues, keyPath) && oldEntry.deleted !== true) {
      entries[keyPath] = { timestamp: now, sequence: nextSequence(), deleted: true };
    }
  }
  return { version: 1, machineId, sequence, entries };
}
function compareEntries(left, right) {
  if (left.entry.timestamp !== right.entry.timestamp) return left.entry.timestamp - right.entry.timestamp;
  if (left.machineId !== right.machineId) return left.machineId < right.machineId ? -1 : 1;
  return left.entry.sequence - right.entry.sequence;
}
function mergeMachineStates(states) {
  if (!Array.isArray(states)) throw new TypeError("Expected machine states array");
  const winners = /* @__PURE__ */ new Map();
  for (const state of states) {
    validateMachineState(state);
    for (const [keyPath, entry] of Object.entries(state.entries)) {
      const candidate = { machineId: state.machineId, entry };
      const current = winners.get(keyPath);
      if (!current || compareEntries(candidate, current) > 0) winners.set(keyPath, candidate);
    }
  }
  const values = {};
  const tombstones = [];
  for (const keyPath of [...winners.keys()].sort()) {
    const { entry } = winners.get(keyPath);
    if (entry.deleted === true) tombstones.push(keyPath);
    else values[keyPath] = canonicalize(entry.value);
  }
  return { values, tombstones };
}

// src/apply-plan.js
var MAX_FILE_VALUE_BYTES = 512 * 1024;
var SETTING_TARGET_ORDER = ["preferences", "opencode", "extensions"];
function planError(code, message) {
  return Object.assign(new Error(message), { code });
}
function isRecord3(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function canonicalValue(value) {
  return JSON.parse(stableJson(value));
}
function isPortableExtensionRepositoryList(value) {
  return Array.isArray(value) && value.every((entry) => {
    if (typeof entry !== "string") return false;
    try {
      const url = new URL(entry);
      return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
    } catch {
      return false;
    }
  });
}
function validateFileText(value) {
  if (typeof value !== "string") throw planError("INVALID_PLAN", "Portable file values must be text");
  const bytes = Buffer2.from(value, "utf8");
  if (bytes.toString("utf8") !== value) {
    throw planError("INVALID_PLAN", "Portable file values must be valid UTF-8 text");
  }
  if (value.includes("\0")) throw planError("INVALID_PLAN", "Portable file values must not contain null bytes");
  if (bytes.length > MAX_FILE_VALUE_BYTES) throw planError("INVALID_PLAN", "Portable file values exceed the size limit");
  if (containsCredentialMarker(value)) throw planError("INVALID_PLAN", "Portable file values must not contain credential-like content");
  return value;
}
function settingChange(target, key, type, rawValue) {
  return {
    kind: "settings",
    target,
    key,
    type,
    ...type === "set" ? { value: canonicalValue(rawValue) } : {}
  };
}
function changeForKey(item, type, remoteValue) {
  const key = item.key;
  if (key.startsWith("preferences.")) {
    const field = key.slice("preferences.".length);
    if (!isPortablePreferenceField(field)) throw planError("INVALID_PLAN", "Unsupported preferences field");
    return settingChange("preferences", field, type, remoteValue);
  }
  if (key.startsWith("opencode.k")) {
    let configKey;
    try {
      configKey = decodeOpenCodeKeyPath(key);
    } catch {
      throw planError("INVALID_PLAN", "Unsupported OpenCode configuration key");
    }
    if (!isPortableOpenCodeConfigKey(configKey)) throw planError("INVALID_PLAN", "Unsupported OpenCode configuration key");
    return settingChange("opencode", configKey, type, remoteValue);
  }
  if (key === "extensions.repositories") {
    if (type === "set" && !isPortableExtensionRepositoryList(remoteValue)) {
      throw planError("INVALID_PLAN", "Extension repository lists must be HTTPS Git origins");
    }
    return settingChange("extensions", "repositories", type, remoteValue);
  }
  if (key.startsWith("opencodeFile.k")) {
    let relativePath;
    try {
      relativePath = decodePortableFileKey(key);
    } catch {
      throw planError("INVALID_PLAN", "Unsupported portable file path");
    }
    const fileType = type === "set" ? "write" : "delete";
    if (type === "set") {
      return { kind: "file", relativePath, type: fileType, text: validateFileText(remoteValue) };
    }
    return { kind: "file", relativePath, type: fileType };
  }
  throw planError("INVALID_PLAN", "Unsupported sync key");
}
function planApplyChanges({ items, remoteValues, tombstones, resolutions }) {
  if (!Array.isArray(items)) throw planError("INVALID_PLAN", "Expected preview items");
  if (!isRecord3(remoteValues)) throw planError("INVALID_PLAN", "Expected remote values");
  if (!Array.isArray(tombstones) || !tombstones.every((key) => typeof key === "string")) {
    throw planError("INVALID_PLAN", "Expected remote tombstones");
  }
  if (typeof resolutions !== "string" || !/^[LR]{0,200}$/.test(resolutions)) {
    throw planError("INVALID_PLAN", "Expected conflict resolutions");
  }
  const tombstoneSet = new Set(tombstones);
  const settingChanges = { preferences: [], opencode: [], extensions: [] };
  const fileChanges = [];
  let conflictIndex = 0;
  for (const item of items) {
    if (!item || typeof item !== "object" || typeof item.key !== "string" || typeof item.action !== "string") {
      throw planError("INVALID_PLAN", "Invalid preview item");
    }
    let applyRemote;
    if (item.action === "download") applyRemote = true;
    else if (item.action === "conflict") {
      const resolution = resolutions[conflictIndex++];
      if (resolution !== "L" && resolution !== "R") throw planError("INVALID_PLAN", "Missing conflict resolution");
      applyRemote = resolution === "R";
    } else if (item.action === "upload") applyRemote = false;
    else throw planError("INVALID_PLAN", "Invalid preview action");
    if (!applyRemote) continue;
    const deleted = item.remote?.deleted === true || tombstoneSet.has(item.key);
    const remoteValue = deleted ? void 0 : remoteValues[item.key];
    if (!deleted && remoteValue === void 0) throw planError("INVALID_PLAN", "Remote value is missing for an approved change");
    const change = changeForKey(item, deleted ? "remove" : "set", remoteValue);
    if (change.kind === "file") fileChanges.push(change);
    else settingChanges[change.target].push(change);
  }
  if (conflictIndex !== resolutions.length) throw planError("INVALID_PLAN", "Unresolved conflict choices remain");
  for (const target of SETTING_TARGET_ORDER) {
    settingChanges[target].sort((left, right) => left.key.localeCompare(right.key));
  }
  fileChanges.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const changeCount = SETTING_TARGET_ORDER.reduce((count, target) => count + settingChanges[target].length, 0) + fileChanges.length;
  if (changeCount === 0) throw planError("NOTHING_TO_APPLY", "The confirmed plan has no changes for this machine");
  return {
    settingChanges,
    fileChanges,
    changeCount
  };
}

// src/bootstrap-preview.js
import { Buffer as Buffer3 } from "node:buffer";
var SOURCE_IDS = ["preferences", "opencode", "opencode-files", "extensions"];
var MAX_PREVIEW_ITEMS = 200;
var MAX_PREVIEW_ITEM_BYTES = 32 * 1024;
var MAX_PREVIEW_TOTAL_BYTES = 512 * 1024;
function isPortableExtensionRepositoryList2(value) {
  return Array.isArray(value) && value.every((entry) => {
    if (typeof entry !== "string") return false;
    try {
      const url = new URL(entry);
      return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
    } catch {
      return false;
    }
  });
}
function describeKey(key, value) {
  if (key.startsWith("preferences.")) {
    const field = key.slice("preferences.".length);
    return isPortablePreferenceField(field) ? { kind: "setting", path: `OpenChamber preferences \xB7 ${field}` } : void 0;
  }
  if (key.startsWith("opencode.k")) {
    try {
      const configKey = decodeOpenCodeKeyPath(key);
      return Buffer3.byteLength(configKey, "utf8") <= 256 && isPortableOpenCodeConfigKey(configKey) ? { kind: "setting", path: `OpenCode opencode.json \xB7 ${configKey}` } : void 0;
    } catch {
      return void 0;
    }
  }
  if (key === "extensions.repositories") {
    return isPortableExtensionRepositoryList2(value) ? { kind: "setting", path: "OpenChamber extensions.json \xB7 Git origins" } : void 0;
  }
  if (key.startsWith("opencodeFile.")) {
    try {
      return { kind: "file", path: `OpenCode ${decodePortableFileKey(key)}` };
    } catch {
      return void 0;
    }
  }
  return void 0;
}
function previewValue(value, kind, budget) {
  if (kind === "file" && typeof value !== "string") {
    return { preview: "[hidden: invalid file value]", complete: false, bytes: 0 };
  }
  const text = kind === "file" ? value : stableJson(value);
  const bytes = Buffer3.byteLength(text, "utf8");
  if (containsCredentialMarker(text)) {
    return { preview: "[hidden: credential-like content]", complete: false, bytes: 0 };
  }
  if (bytes > MAX_PREVIEW_ITEM_BYTES || bytes > budget) {
    return { preview: "[hidden: value exceeds the preview limit]", complete: false, bytes: 0 };
  }
  return { preview: text, complete: true, bytes };
}
function createBootstrapPreview(local, states) {
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
    canConfirm: false
  };
  for (const id of SOURCE_IDS) {
    if (local.sources[id]?.status !== "ready") preview.blockedSources.push(id);
  }
  const tombstones = new Set(remote.tombstones);
  const keys = [.../* @__PURE__ */ new Set([...Object.keys(local.values), ...Object.keys(remote.values)])].sort();
  let previewBytes = 0;
  const changes = [];
  for (const key of keys) {
    const hasLocal = Object.hasOwn(local.values, key);
    const hasRemote = Object.hasOwn(remote.values, key);
    const remoteDeleted = tombstones.has(key);
    let action;
    if (!hasLocal && !hasRemote) continue;
    if (hasLocal && remoteDeleted) {
      action = "conflict";
      preview.conflicts += 1;
    } else if (hasLocal && !hasRemote) {
      action = "upload";
      preview.localOnly += 1;
    } else if (!hasLocal && hasRemote) {
      action = "download";
      preview.remoteOnly += 1;
    } else if (stableJson(local.values[key]) === stableJson(remote.values[key])) {
      preview.unchanged += 1;
      continue;
    } else {
      action = "conflict";
      preview.conflicts += 1;
    }
    const localDescription = hasLocal ? describeKey(key, local.values[key]) : void 0;
    const remoteDescription = hasRemote ? describeKey(key, remote.values[key]) : void 0;
    const description = localDescription ?? remoteDescription;
    if (!description || hasLocal && !localDescription || hasRemote && !remoteDescription || localDescription && remoteDescription && (localDescription.kind !== remoteDescription.kind || localDescription.path !== remoteDescription.path)) {
      preview.unsupportedItems += 1;
      continue;
    }
    changes.push({
      key,
      ...description,
      action,
      localValue: hasLocal ? local.values[key] : void 0,
      remoteValue: hasRemote ? remote.values[key] : void 0,
      remoteDeleted
    });
  }
  changes.sort((left, right) => left.path.localeCompare(right.path));
  for (const change of changes) {
    if (preview.items.length >= MAX_PREVIEW_ITEMS) {
      preview.omittedItems += changes.length - preview.items.length;
      break;
    }
    const budget = MAX_PREVIEW_TOTAL_BYTES - previewBytes;
    const local2 = change.localValue === void 0 ? { present: false, deleted: false, preview: "", complete: true } : { present: true, deleted: false, ...previewValue(change.localValue, change.kind, budget) };
    previewBytes += local2.complete ? Buffer3.byteLength(local2.preview, "utf8") : 0;
    const remote2 = change.remoteDeleted ? { present: false, deleted: true, preview: "", complete: true } : change.remoteValue === void 0 ? { present: false, deleted: false, preview: "", complete: true } : { present: true, deleted: false, ...previewValue(change.remoteValue, change.kind, MAX_PREVIEW_TOTAL_BYTES - previewBytes) };
    previewBytes += remote2.complete ? Buffer3.byteLength(remote2.preview, "utf8") : 0;
    if (!local2.complete || !remote2.complete) preview.incompleteItems += 1;
    preview.items.push({
      key: change.key,
      path: change.path,
      kind: change.kind,
      action: change.action,
      local: local2,
      remote: remote2,
      complete: local2.complete && remote2.complete
    });
  }
  preview.canConfirm = preview.blockedSources.length === 0 && preview.unsupportedItems === 0 && preview.incompleteItems === 0 && preview.omittedItems === 0;
  return preview;
}

// src/local-apply.js
import { Buffer as Buffer4 } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { constants as constants3 } from "node:fs";
import { link, lstat as lstat2, mkdir, open as open3, rename, rm } from "node:fs/promises";
import path4 from "node:path";
var MAX_SETTINGS_FILE_BYTES = 2 * 1024 * 1024;
var MAX_PORTABLE_FILE_BYTES = 512 * 1024;
var MAX_TOTAL_PORTABLE_FILE_BYTES = 4 * 1024 * 1024;
var JOURNAL_VERSION = 1;
var MAX_JOURNAL_STEPS = 300;
function applyError(code, message) {
  return Object.assign(new Error(message), { code });
}
function simulatedCrashError() {
  return applyError("SIMULATED_CRASH", "Simulated interruption");
}
function isRecord4(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
function defaultApplyJournalPath(openChamberDir2) {
  if (typeof openChamberDir2 !== "string") throw new TypeError("OpenChamber config directory is required");
  return path4.join(openChamberDir2, ".openchamber-sync-apply-journal.json");
}
async function atomicWriteFile(filePath, text, mode) {
  const temp = `${filePath}.${randomBytes(8).toString("hex")}.sync-jtmp`;
  let handle;
  try {
    handle = await open3(temp, constants3.O_WRONLY | constants3.O_CREAT | constants3.O_EXCL, mode);
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {
    });
  }
  try {
    await rename(temp, filePath);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {
    });
    throw error;
  }
}
async function readSettingsFile(filePath) {
  let handle;
  try {
    handle = await open3(filePath, constants3.O_RDONLY | (constants3.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_SETTINGS_FILE_BYTES) {
      throw applyError("APPLY_TARGET_UNAVAILABLE", "A local settings file is not a readable regular file");
    }
    const text = await handle.readFile("utf8");
    const value = JSON.parse(text);
    if (!isRecord4(value)) throw new TypeError("Settings must be a JSON object");
    return { existed: true, mode: info.mode & 4095, value };
  } catch (error) {
    if (error?.code === "APPLY_TARGET_UNAVAILABLE") throw error;
    if (error && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ELOOP" || error.code === "ENOTDIR")) {
      throw applyError("APPLY_TARGET_UNAVAILABLE", "A local settings file is missing or unsafe to read");
    }
    throw applyError("APPLY_TARGET_UNAVAILABLE", "A local settings file could not be parsed");
  } finally {
    await handle?.close().catch(() => {
    });
  }
}
async function serializeTargetFile(filePath) {
  let info;
  try {
    info = await lstat2(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return { existed: false };
    throw applyError("APPLY_TARGET_UNAVAILABLE", "A local target path could not be inspected");
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw applyError("APPLY_TARGET_UNAVAILABLE", "A local target path is not a regular file");
  }
  return { existed: true, mode: info.mode & 4095 };
}
function normalizeHttpsOrigin(url) {
  if (typeof url !== "string") return void 0;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) return void 0;
    return parsed.toString();
  } catch {
    return void 0;
  }
}
function buildExtensionsContent(base, changes) {
  const change = changes[0];
  const baseOrigins = isRecord4(base.gitOrigins) ? base.gitOrigins : {};
  const targetSet = change.type === "set" ? new Set(change.value) : /* @__PURE__ */ new Set();
  const origins = {};
  const covered = /* @__PURE__ */ new Set();
  for (const [key, entry] of Object.entries(baseOrigins)) {
    const normalized = isRecord4(entry) ? normalizeHttpsOrigin(entry.url) : void 0;
    if (!normalized || !targetSet.has(normalized)) {
      if (!normalized) origins[key] = entry;
      continue;
    }
    origins[key] = entry;
    covered.add(normalized);
  }
  if (change.type === "set") {
    for (const url of [...change.value].sort()) {
      if (covered.has(url)) continue;
      const parsed = new URL(url);
      const base2 = `${parsed.hostname}${parsed.pathname}${parsed.search}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "extension";
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
  if (target === "preferences") {
    if (content.fields !== void 0 && !isRecord4(content.fields)) {
      throw applyError("APPLY_TARGET_UNAVAILABLE", "Local preferences fields are not an object");
    }
    if (!isRecord4(content.fields)) content.fields = {};
    for (const change of changes) {
      if (change.type === "set") content.fields[change.key] = change.value;
      else delete content.fields[change.key];
    }
    return content;
  }
  if (target === "opencode") {
    for (const change of changes) {
      if (change.type === "set") content[change.key] = change.value;
      else delete content[change.key];
    }
    return content;
  }
  return buildExtensionsContent(base, changes);
}
function settingsTargetPath(target, { openChamberDir: openChamberDir2, openCodeDir: openCodeDir2 }) {
  if (target === "preferences") return path4.join(openChamberDir2, "preferences.json");
  if (target === "extensions") return path4.join(openChamberDir2, "extensions.json");
  return path4.join(openCodeDir2, "opencode.json");
}
async function ensureFileDirectory(openCodeDir2, relativePath) {
  const rootInfo = await lstat2(openCodeDir2).catch((error) => {
    throw applyError("APPLY_TARGET_UNAVAILABLE", "The OpenCode configuration directory is unavailable");
  });
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw applyError("APPLY_TARGET_UNAVAILABLE", "The OpenCode configuration directory is unavailable");
  }
  const createdDirs = [];
  let current = openCodeDir2;
  for (const part of relativePath.split("/").slice(0, -1)) {
    const next = path4.join(current, part);
    let info;
    try {
      info = await lstat2(next);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw applyError("APPLY_TARGET_UNAVAILABLE", "A local target directory could not be inspected");
      }
      await mkdir(next);
      createdDirs.push(next);
      info = await lstat2(next);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw applyError("APPLY_TARGET_UNAVAILABLE", "A local target directory is not a real directory");
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
  }
  let handle;
  try {
    handle = await open3(step.absolutePath, constants3.O_RDONLY | (constants3.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_SETTINGS_FILE_BYTES) {
      throw applyError("APPLY_TARGET_UNAVAILABLE", "A local target file could not be backed up");
    }
    const text = await handle.readFile("utf8");
    await atomicWriteFile(step.backup, text, info.mode & 4095);
  } finally {
    await handle?.close().catch(() => {
    });
  }
}
function buildSteps(plan, { openChamberDir: openChamberDir2, openCodeDir: openCodeDir2 }) {
  const steps = [];
  for (const target of ["preferences", "opencode", "extensions"]) {
    const changes = plan.settingChanges[target];
    if (!changes || changes.length === 0) continue;
    steps.push({
      kind: "settings",
      target,
      type: "write",
      changes,
      absolutePath: settingsTargetPath(target, { openChamberDir: openChamberDir2, openCodeDir: openCodeDir2 })
    });
  }
  for (const change of plan.fileChanges) {
    const absolutePath = path4.join(openCodeDir2, change.relativePath);
    if (path4.relative(openCodeDir2, absolutePath).startsWith("..") || path4.isAbsolute(path4.relative(openCodeDir2, absolutePath))) {
      throw applyError("APPLY_TARGET_UNAVAILABLE", "A portable file target escapes the OpenCode directory");
    }
    steps.push({
      kind: "file",
      target: change.target,
      relativePath: change.relativePath,
      type: change.type,
      text: change.text,
      absolutePath
    });
  }
  steps.sort((left, right) => left.absolutePath.localeCompare(right.absolutePath));
  if (steps.length > MAX_JOURNAL_STEPS) throw applyError("APPLY_LIMIT_EXCEEDED", "The plan exceeds the supported number of file changes");
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
      status: step.status ?? "prepared"
    }))
  };
}
function validateJournalDocument(value) {
  if (!isRecord4(value) || value.version !== JOURNAL_VERSION || typeof value.planId !== "string" || !/^[a-f0-9]{64}$/.test(value.planId) || !Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > MAX_JOURNAL_STEPS) {
    throw applyError("APPLY_JOURNAL_INVALID", "The apply recovery marker is invalid");
  }
  for (const step of value.steps) {
    if (!isRecord4(step) || !Number.isSafeInteger(step.id) || step.id < 0 || step.id >= value.steps.length || typeof step.target !== "string" || !path4.isAbsolute(step.target) || step.target.length > 1200 || !["settings", "file"].includes(step.kind) || !["write", "delete"].includes(step.type) || step.temp !== null && (typeof step.temp !== "string" || !path4.isAbsolute(step.temp)) || step.backup !== null && (typeof step.backup !== "string" || !path4.isAbsolute(step.backup)) || typeof step.created !== "boolean" || !Array.isArray(step.createdDirs) || step.createdDirs.length > 64 || step.createdDirs.some((dir) => typeof dir !== "string" || !path4.isAbsolute(dir)) || step.resultHash !== null && (typeof step.resultHash !== "string" || !/^[a-f0-9]{64}$/.test(step.resultHash)) || !["prepared", "done"].includes(step.status)) {
      throw applyError("APPLY_JOURNAL_INVALID", "The apply recovery marker is invalid");
    }
  }
  return value;
}
async function readJournalFile(journalPath) {
  let handle;
  try {
    handle = await open3(journalPath, constants3.O_RDONLY | (constants3.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1024 * 1024) {
      throw applyError("APPLY_JOURNAL_INVALID", "The apply recovery marker is invalid");
    }
    const text = await handle.readFile("utf8");
    return validateJournalDocument(JSON.parse(text));
  } catch (error) {
    if (error?.code === "APPLY_JOURNAL_INVALID") throw error;
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return void 0;
    throw applyError("APPLY_JOURNAL_INVALID", "The apply recovery marker is invalid");
  } finally {
    await handle?.close().catch(() => {
    });
  }
}
async function hashTargetIfFile(filePath) {
  let handle;
  try {
    handle = await open3(filePath, constants3.O_RDONLY | (constants3.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_SETTINGS_FILE_BYTES) return void 0;
    const text = await handle.readFile("utf8");
    return sha256Text(text);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    return void 0;
  } finally {
    await handle?.close().catch(() => {
    });
  }
}
async function recoverApplyJournal({ journalPath }) {
  if (typeof journalPath !== "string") throw new TypeError("A journal path is required");
  const journal = await readJournalFile(journalPath);
  if (!journal) return { recovered: false };
  let rolledBack = 0;
  for (const step of [...journal.steps].reverse()) {
    if (step.backup) {
      const hash = await hashTargetIfFile(step.target);
      if (hash === null || hash === step.resultHash) {
        await rename(step.backup, step.target).catch((error) => {
          if (error?.code === "ENOENT") return;
          throw error;
        });
      }
    } else if (step.created && step.type === "write") {
      const hash = await hashTargetIfFile(step.target);
      if (hash === null || hash === step.resultHash) {
        await rm(step.target, { force: true }).catch(() => {
        });
      }
    }
    if (step.temp) await rm(step.temp, { force: true }).catch(() => {
    });
    for (const dir of [...step.createdDirs ?? []].reverse()) {
      await rm(dir, { force: true }).catch(() => {
      });
    }
    rolledBack += 1;
  }
  await rm(journalPath, { force: true }).catch(() => {
  });
  return { recovered: true, rolledBack };
}
async function writeStep(step) {
  if (step.type === "delete") {
    if (step.existed) await backupTarget(step);
    await rm(step.absolutePath, { force: false }).catch((error) => {
      if (error?.code === "ENOENT") return;
      throw applyError("APPLY_TARGET_UNAVAILABLE", "A local file could not be removed");
    });
    return;
  }
  const temp = `${step.absolutePath}.sync-tmp-${randomBytes(8).toString("hex")}`;
  const mode = step.existed ? step.mode : 384;
  let handle;
  try {
    handle = await open3(temp, constants3.O_WRONLY | constants3.O_CREAT | constants3.O_EXCL, mode);
    await handle.writeFile(step.newText, "utf8");
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {
    });
  }
  step.temp = temp;
  if (step.existed) await backupTarget(step);
  await rename(temp, step.absolutePath);
}
async function applyPlanToFiles(plan, {
  openChamberDir: openChamberDir2,
  openCodeDir: openCodeDir2,
  journalPath,
  planId,
  crashAfterSteps,
  crashPhase
} = {}) {
  if (typeof openChamberDir2 !== "string" || typeof openCodeDir2 !== "string") {
    throw new TypeError("OpenChamber and OpenCode config directories are required");
  }
  if (typeof planId !== "string" || !/^[a-f0-9]{64}$/.test(planId)) throw new TypeError("A plan digest is required");
  if (journalPath === void 0) journalPath = defaultApplyJournalPath(openChamberDir2);
  if (typeof journalPath !== "string") throw new TypeError("A journal path is required");
  const existing = await readJournalFile(journalPath).catch((error) => {
    if (error?.code === "APPLY_JOURNAL_INVALID") throw error;
    throw applyError("APPLY_JOURNAL_INVALID", "The apply recovery marker is invalid");
  });
  const recovery = existing ? await recoverApplyJournal({ journalPath }) : { recovered: false };
  const steps = buildSteps(plan, { openChamberDir: openChamberDir2, openCodeDir: openCodeDir2 });
  let totalFileBytes = 0;
  for (const step of steps) {
    if (step.kind === "settings") {
      const read = await readSettingsFile(step.absolutePath);
      step.existed = read.existed;
      step.mode = read.mode;
      const content = buildSettingsContent(step.target, read.value, step.changes);
      step.newText = `${JSON.stringify(content, null, 2)}
`;
    } else if (step.type === "write") {
      const { directory, createdDirs } = await ensureFileDirectory(openCodeDir2, step.relativePath);
      step.createdDirs = createdDirs;
      const serialized = await serializeTargetFile(step.absolutePath);
      step.existed = serialized.existed;
      step.mode = serialized.mode;
      const bytes = Buffer4.byteLength(step.text, "utf8");
      if (bytes > MAX_PORTABLE_FILE_BYTES) throw applyError("APPLY_LIMIT_EXCEEDED", "A portable file exceeds the size limit");
      totalFileBytes += bytes;
      if (totalFileBytes > MAX_TOTAL_PORTABLE_FILE_BYTES) {
        throw applyError("APPLY_LIMIT_EXCEEDED", "Portable files exceed the total size limit");
      }
      step.newText = step.text;
    } else {
      const serialized = await serializeTargetFile(step.absolutePath);
      step.existed = serialized.existed;
    }
    step.resultHash = step.type === "write" ? sha256Text(step.newText) : null;
    step.created = step.type === "write" && !step.existed;
  }
  for (const step of steps) {
    if (step.type === "write") {
      step.temp = `${step.absolutePath}.sync-tmp-${randomBytes(8).toString("hex")}`;
    }
    step.backup = step.existed ? `${step.absolutePath}.sync-backup-${randomBytes(8).toString("hex")}` : null;
    step.status = "prepared";
  }
  await atomicWriteFile(journalPath, `${JSON.stringify(journalDocument(planId, steps), null, 2)}
`, 384);
  if (crashPhase === "journal") throw simulatedCrashError();
  let completed = 0;
  for (const step of steps) {
    await writeStep(step);
    step.status = "done";
    await atomicWriteFile(journalPath, `${JSON.stringify(journalDocument(planId, steps), null, 2)}
`, 384);
    completed += 1;
    if (crashPhase === "write" && Number.isInteger(crashAfterSteps) && completed >= crashAfterSteps) {
      throw simulatedCrashError();
    }
  }
  if (crashPhase === "cleanup") throw simulatedCrashError();
  for (const step of steps) {
    if (step.backup) await rm(step.backup, { force: true }).catch(() => {
    });
    if (step.temp) await rm(step.temp, { force: true }).catch(() => {
    });
  }
  await rm(journalPath, { force: true }).catch(() => {
  });
  return { applied: completed, recovered: recovery.recovered === true };
}

// src/repository.js
import { execFile as nodeExecFile } from "node:child_process";
function repositoryError(code) {
  const message = code === "INVALID_REPOSITORY_REMOTE" ? "Invalid GitHub repository remote" : "Git repository access failed";
  return Object.assign(new Error(message), { code });
}
function normalizeGitHubRemote(value) {
  if (typeof value !== "string" || value.length > 2048) {
    throw repositoryError("INVALID_REPOSITORY_REMOTE");
  }
  const input = value.trim();
  const sshMatch = input.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (sshMatch) {
    const owner2 = sshMatch[1];
    const name2 = sshMatch[2];
    if (!name2 || [owner2, name2].some((part) => part === "." || part === ".." || part.endsWith(".git"))) {
      throw repositoryError("INVALID_REPOSITORY_REMOTE");
    }
    return {
      url: `git@github.com:${owner2}/${name2}.git`,
      repository: `${owner2}/${name2}`,
      transport: "ssh"
    };
  }
  const authority = input.match(/^https:\/\/([^/?#]*)/i)?.[1];
  if (!authority || authority.includes("@")) throw repositoryError("INVALID_REPOSITORY_REMOTE");
  let url;
  try {
    url = new URL(input);
  } catch {
    throw repositoryError("INVALID_REPOSITORY_REMOTE");
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash) {
    throw repositoryError("INVALID_REPOSITORY_REMOTE");
  }
  const match = url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (!match || match[1] === "." || match[1] === ".." || match[2] === "." || match[2] === "..") {
    throw repositoryError("INVALID_REPOSITORY_REMOTE");
  }
  const owner = match[1];
  const name = match[2];
  if (!name || name.endsWith(".git")) throw repositoryError("INVALID_REPOSITORY_REMOTE");
  return {
    url: `https://github.com/${owner}/${name}.git`,
    repository: `${owner}/${name}`,
    transport: "https"
  };
}
function diagnosticReason(code, stderr, transport) {
  if (code === "GIT_NOT_INSTALLED") return "git-unavailable";
  if (code === "GIT_TIMEOUT") return "timeout";
  const output = typeof stderr === "string" ? stderr : "";
  if (transport === "ssh" && /host key verification failed|remote host identification has changed/i.test(output)) return "ssh-host-key";
  if (transport === "ssh" && /permission denied \(publickey/i.test(output)) return "ssh-authentication";
  if (/could not resolve hostname|could not resolve host|name or service not known/i.test(output)) return "dns";
  if (/connection refused|connection timed out|network is unreachable|no route to host/i.test(output)) return "connection";
  if (/repository not found/i.test(output)) return "repository-not-found";
  if (transport === "ssh" && /cannot run ssh:|ssh: (?:not found|no such file or directory)/i.test(output)) return "ssh-unavailable";
  return "unknown";
}
function probeGitHubRepo(value, { execFile = nodeExecFile } = {}) {
  let remote;
  try {
    remote = normalizeGitHubRemote(value);
  } catch {
    return Promise.reject(repositoryError("INVALID_REPOSITORY_REMOTE"));
  }
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never"
    };
    if (remote.transport === "ssh") {
      env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes -o ConnectTimeout=5";
    }
    execFile("git", ["ls-remote", "--heads", remote.url], {
      shell: false,
      timeout: 7e3,
      maxBuffer: 1024 * 1024,
      env
    }, (error, _stdout, stderr) => {
      if (!error) {
        resolve(remote);
        return;
      }
      const code = error.code === "ENOENT" ? "GIT_NOT_INSTALLED" : error.killed || error.code === "ETIMEDOUT" ? "GIT_TIMEOUT" : "GIT_ACCESS_FAILED";
      const failure = repositoryError(code);
      failure.diagnostics = {
        transport: remote.transport,
        reason: diagnosticReason(code, stderr, remote.transport),
        ...remote.transport === "ssh" ? { sshAgent: env.SSH_AUTH_SOCK ? "configured" : "not-configured" } : {},
        ...Number.isInteger(error.code) && error.code >= 0 && error.code <= 255 ? { exitCode: error.code } : {}
      };
      reject(failure);
    });
  });
}

// src/repository-push.js
import { execFile as nodeExecFile2 } from "node:child_process";
import { mkdir as mkdir2, mkdtemp, rm as rm2, writeFile } from "node:fs/promises";
import os from "node:os";
import path5 from "node:path";
import { performance } from "node:perf_hooks";
var MAX_OPERATION_MS = 15e3;
var MAX_COMMAND_MS = 1e4;
var MAX_STATE_BYTES = 8 * 1024 * 1024;
var MAX_PUSH_OUTPUT_BYTES = 1024 * 1024;
var STATE_PATH_PATTERN = /^machines\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/state\.json$/;
var COMMIT_MESSAGE = "OpenChamber Sync: initial machine state";
var COMMIT_NAME = "OpenChamber Sync";
var COMMIT_EMAIL = "sync@openchamber.invalid";
var NON_FAST_FORWARD_PATTERN = /\[\s*rejected\]|non-fast-forward|fetch first/i;
var FILTER_UNSUPPORTED_PATTERN = /filtering not recognized by server|filter(?:ing)?[^\n]*not supported/i;
var SAFE_PUSH_ERRORS = /* @__PURE__ */ new WeakSet();
function pushError(code) {
  const messages = {
    INVALID_REPOSITORY_REMOTE: "Invalid GitHub repository remote",
    GIT_NOT_INSTALLED: "Git is not available",
    GIT_TIMEOUT: "Git repository operation timed out",
    REPOSITORY_CHANGED: "The remote moved while the initial state was being pushed. Refresh the comparison and confirm again.",
    GIT_PUSH_FAILED: "Git could not update the target remote",
    REMOTE_FILTER_UNSUPPORTED: "The repository server could not provide bounded state data",
    STATE_TOO_LARGE: "The machine state exceeds the supported size limit"
  };
  const error = Object.assign(new Error(messages[code] ?? "Git repository push failed"), { code });
  SAFE_PUSH_ERRORS.add(error);
  return error;
}
function shaText(output) {
  const value = output.toString("utf8").trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)) throw pushError("GIT_PUSH_FAILED");
  return value;
}
function headShaFromLsRemote(output) {
  const text = output.toString("utf8").trim();
  if (text === "") return null;
  const sha = text.split("	")[0]?.trim() ?? "";
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha)) throw pushError("GIT_ACCESS_FAILED");
  return sha;
}
function existingBlobShaFromLsTree(output, statePath) {
  const text = output.toString("utf8");
  for (const record of text.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("	");
    if (tab < 0) throw pushError("GIT_ACCESS_FAILED");
    const metadata = record.slice(0, tab).split(" ");
    if (metadata.length !== 3 || metadata[0] !== "100644" || metadata[1] !== "blob" || record.slice(tab + 1) !== statePath) {
      throw pushError("GIT_ACCESS_FAILED");
    }
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(metadata[2])) throw pushError("GIT_ACCESS_FAILED");
    return metadata[2];
  }
  return null;
}
async function pushBootstrapState({
  url,
  branch = "main",
  path: statePath,
  content,
  commitTimestamp = Date.now(),
  execFile = nodeExecFile2,
  now = () => performance.now()
}) {
  let remote;
  try {
    remote = normalizeGitHubRemote(url);
  } catch {
    throw pushError("INVALID_REPOSITORY_REMOTE");
  }
  if (branch !== "main") throw new TypeError("Bootstrap pushes only to the main branch");
  if (typeof statePath !== "string" || !STATE_PATH_PATTERN.test(statePath)) {
    throw new TypeError("Invalid initial state path");
  }
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_STATE_BYTES) {
    throw pushError("STATE_TOO_LARGE");
  }
  if (!Number.isSafeInteger(commitTimestamp) || commitTimestamp < 0) {
    throw new TypeError("Invalid commit timestamp");
  }
  const startedAt = now();
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_OPTIONAL_LOCKS: "0"
  };
  if (remote.transport === "ssh") {
    env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes -o ConnectTimeout=5";
  }
  const runGit = (args, { maxBuffer = 256 * 1024, extraEnv } = {}) => new Promise((resolve, reject) => {
    const remaining = MAX_OPERATION_MS - (now() - startedAt);
    if (remaining <= 0) {
      reject(pushError("GIT_TIMEOUT"));
      return;
    }
    execFile("git", args, {
      shell: false,
      encoding: "buffer",
      timeout: Math.max(1, Math.min(MAX_COMMAND_MS, remaining)),
      maxBuffer,
      env: extraEnv ? { ...env, ...extraEnv } : env
    }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ stdout, stderr });
        return;
      }
      if (error.code === "ENOENT") reject(pushError("GIT_NOT_INSTALLED"));
      else if (error.killed || error.code === "ETIMEDOUT") reject(pushError("GIT_TIMEOUT"));
      else if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") reject(pushError("GIT_PUSH_FAILED"));
      else {
        reject(Object.assign(new Error("Git repository push failed"), {
          code: "GIT_ACCESS_FAILED",
          stderrText: stderr?.toString("utf8").slice(0, 4096) ?? ""
        }));
      }
    });
  });
  let temporaryDirectory;
  try {
    temporaryDirectory = await mkdtemp(path5.join(os.tmpdir(), "openchamber-sync-push-"));
    const repositoryDirectory = path5.join(temporaryDirectory, "repository");
    const templateDirectory = path5.join(temporaryDirectory, "template");
    const hooksDirectory = path5.join(temporaryDirectory, "hooks");
    const indexFile = path5.join(temporaryDirectory, "index");
    const contentFile = path5.join(temporaryDirectory, "state.json");
    await Promise.all([mkdir2(templateDirectory), mkdir2(hooksDirectory)]);
    await writeFile(contentFile, content, { mode: 384 });
    const gitConfig = ["-c", `core.hooksPath=${hooksDirectory}`, "-c", "core.fsmonitor=false", "-c", "fetch.fsckObjects=true"];
    await runGit([...gitConfig, "init", "--bare", "--quiet", `--template=${templateDirectory}`, repositoryDirectory]);
    const localGit = (args, options) => runGit(["-C", repositoryDirectory, ...gitConfig, ...args], options);
    let parentSha = null;
    let baseTreeSha = null;
    try {
      const refs = await runGit(["ls-remote", remote.url, "refs/heads/main"], { maxBuffer: 4096 });
      parentSha = headShaFromLsRemote(refs.stdout);
      if (parentSha) {
        await localGit(["remote", "add", "origin", remote.url], { maxBuffer: 4096 });
        await localGit(["config", "extensions.partialClone", "origin"], { maxBuffer: 4096 });
        await localGit(["config", "remote.origin.promisor", "true"], { maxBuffer: 4096 });
        await localGit(["config", "remote.origin.partialclonefilter", "blob:none"], { maxBuffer: 4096 });
        const fetch = await localGit(["fetch", "--filter=blob:none", "--depth=1", "--no-tags", "--no-recurse-submodules", "origin", "refs/heads/main"], {
          maxBuffer: 1024 * 1024
        });
        if (FILTER_UNSUPPORTED_PATTERN.test(fetch.stderr.toString("utf8"))) {
          throw pushError("REMOTE_FILTER_UNSUPPORTED");
        }
        const commit2 = await localGit(["rev-parse", "--verify", "FETCH_HEAD^{commit}"], { maxBuffer: 4096 });
        parentSha = shaText(commit2.stdout);
        const tree2 = await localGit(["rev-parse", "--verify", `${parentSha}^{tree}`], { maxBuffer: 4096 });
        baseTreeSha = shaText(tree2.stdout);
      }
    } catch (error) {
      if (error && SAFE_PUSH_ERRORS.has(error)) throw error;
      throw pushError("GIT_ACCESS_FAILED");
    }
    const hash = await localGit(["hash-object", "-w", "--", contentFile], { maxBuffer: 4096 });
    const blobSha = shaText(hash.stdout);
    if (parentSha) {
      const existing = await localGit(["ls-tree", "-z", parentSha, "--", statePath], { maxBuffer: 4096 });
      if (existingBlobShaFromLsTree(existing.stdout, statePath) === blobSha) {
        return { commit: parentSha, branch, unchanged: true };
      }
    }
    if (parentSha) {
      await localGit(["read-tree", baseTreeSha], { maxBuffer: 4096, extraEnv: { GIT_INDEX_FILE: indexFile } });
    }
    await localGit(["update-index", "--add", "--cacheinfo", "100644", blobSha, statePath], {
      extraEnv: { GIT_INDEX_FILE: indexFile }
    });
    const tree = await localGit(["write-tree"], { maxBuffer: 4096, extraEnv: { GIT_INDEX_FILE: indexFile } });
    const treeSha = shaText(tree.stdout);
    const commitSeconds = Math.floor(commitTimestamp / 1e3);
    const commitDate = `@${commitSeconds} +0000`;
    const commit = await localGit([
      "-c",
      "commit.gpgsign=false",
      "commit-tree",
      treeSha,
      ...parentSha ? ["-p", parentSha] : [],
      "-m",
      COMMIT_MESSAGE
    ], {
      maxBuffer: 4096,
      extraEnv: {
        GIT_AUTHOR_NAME: COMMIT_NAME,
        GIT_AUTHOR_EMAIL: COMMIT_EMAIL,
        GIT_COMMITTER_NAME: COMMIT_NAME,
        GIT_COMMITTER_EMAIL: COMMIT_EMAIL,
        GIT_AUTHOR_DATE: commitDate,
        GIT_COMMITTER_DATE: commitDate
      }
    });
    const commitSha = shaText(commit.stdout);
    await localGit(["update-ref", `refs/heads/${branch}`, commitSha]);
    try {
      await localGit(["-c", "push.gpgSign=false", "push", remote.url, `refs/heads/${branch}:refs/heads/${branch}`], {
        maxBuffer: MAX_PUSH_OUTPUT_BYTES
      });
    } catch (error) {
      if (error?.code === "GIT_ACCESS_FAILED" && NON_FAST_FORWARD_PATTERN.test(error.stderrText ?? "")) {
        throw pushError("REPOSITORY_CHANGED");
      }
      throw error;
    }
    return { commit: commitSha, branch, unchanged: false };
  } catch (error) {
    if (error && SAFE_PUSH_ERRORS.has(error)) throw error;
    if (error?.code === "GIT_ACCESS_FAILED") {
      if (NON_FAST_FORWARD_PATTERN.test(error.stderrText ?? "")) throw pushError("REPOSITORY_CHANGED");
      throw pushError("GIT_PUSH_FAILED");
    }
    throw pushError("GIT_PUSH_FAILED");
  } finally {
    if (temporaryDirectory) await rm2(temporaryDirectory, { recursive: true, force: true }).catch(() => {
    });
  }
}

// src/repository-diagnostics.js
var reasons = {
  "ssh-authentication": "SSH reported public key authentication failure. Check the key available to the service and GitHub account access.",
  "ssh-host-key": "SSH reported a host key verification problem. Verify GitHub\u2019s host key and this service user\u2019s known_hosts.",
  dns: "SSH or Git could not resolve the host. Check DNS and network settings.",
  connection: "The connection failed or was refused. Check the network, SSH port, and firewall.",
  "repository-not-found": "The repository was not found or the account does not have access. Check the address and permissions.",
  "ssh-unavailable": "Git could not start SSH. Check that ssh is installed and available to the service.",
  timeout: "The Git command timed out. Check network connectivity and try again.",
  "git-unavailable": "Git could not be started by the service.",
  unknown: "Git failed without a recognized diagnostic. Check the repository, authentication, and network."
};
function sanitizeRepositoryDiagnostics(value) {
  if (!value || typeof value !== "object" || !Object.hasOwn(reasons, value.reason) || !["ssh", "https"].includes(value.transport)) return void 0;
  const diagnostics = { transport: value.transport, reason: value.reason };
  if (value.transport === "ssh" && ["configured", "not-configured"].includes(value.sshAgent)) {
    diagnostics.sshAgent = value.sshAgent;
  }
  if (Number.isInteger(value.exitCode) && value.exitCode >= 0 && value.exitCode <= 255) {
    diagnostics.exitCode = value.exitCode;
  }
  return diagnostics;
}

// src/remote-state.js
import { execFile as nodeExecFile3 } from "node:child_process";
import { mkdir as mkdir3, mkdtemp as mkdtemp2, rm as rm3 } from "node:fs/promises";
import os2 from "node:os";
import path6 from "node:path";
import { performance as performance2 } from "node:perf_hooks";
var MAX_REF_OUTPUT_BYTES = 1024 * 1024;
var MAX_TREE_OUTPUT_BYTES = 2 * 1024 * 1024;
var MAX_STATE_BYTES2 = 8 * 1024 * 1024;
var MAX_TOTAL_STATE_BYTES = 32 * 1024 * 1024;
var MAX_MACHINE_STATES = 64;
var MAX_ENTRIES_PER_STATE = 4096;
var MAX_TOTAL_STATE_ENTRIES = 16384;
var MAX_OPERATION_MS2 = 15e3;
var MAX_COMMAND_MS2 = 1e4;
var SAFE_REMOTE_ERRORS = /* @__PURE__ */ new WeakSet();
function remoteStateError(code) {
  const messages = {
    INVALID_REPOSITORY_REMOTE: "Invalid GitHub repository remote",
    GIT_TIMEOUT: "Git repository operation timed out",
    GIT_NOT_INSTALLED: "Git is not available",
    REMOTE_FILTER_UNSUPPORTED: "Remote Git server does not support bounded blob filtering",
    REMOTE_STATE_TOO_LARGE: "Remote repository state exceeds the supported size limit",
    REMOTE_STATE_INVALID: "Remote repository state is invalid"
  };
  const error = Object.assign(new Error(messages[code] ?? "Git repository access failed"), { code });
  SAFE_REMOTE_ERRORS.add(error);
  return error;
}
function outputBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return Buffer.alloc(0);
}
function utf8Text(value) {
  const text = value.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(value)) throw remoteStateError("REMOTE_STATE_INVALID");
  return text;
}
function parseMachineTree(output) {
  if (output.length > MAX_TREE_OUTPUT_BYTES) throw remoteStateError("REMOTE_STATE_TOO_LARGE");
  if (output.length === 0) return [];
  if (output[output.length - 1] !== 0) throw remoteStateError("REMOTE_STATE_INVALID");
  const states = [];
  const machineIds = /* @__PURE__ */ new Set();
  let start = 0;
  while (start < output.length) {
    const end = output.indexOf(0, start);
    if (end < 0) throw remoteStateError("REMOTE_STATE_INVALID");
    const record = output.subarray(start, end);
    const tab = record.indexOf(9);
    if (tab < 0) throw remoteStateError("REMOTE_STATE_INVALID");
    const metadata = record.subarray(0, tab).toString("ascii").split(" ");
    const relativePathBytes = record.subarray(tab + 1);
    const relativePath = utf8Text(relativePathBytes);
    const match = relativePath.match(/^machines\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/state\.json$/);
    if (metadata.length !== 3 || metadata[0] !== "100644" || metadata[1] !== "blob" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(metadata[2]) || !match || machineIds.has(match[1])) {
      throw remoteStateError("REMOTE_STATE_INVALID");
    }
    machineIds.add(match[1]);
    states.push({ machineId: match[1], relativePath });
    if (states.length > MAX_MACHINE_STATES) throw remoteStateError("REMOTE_STATE_TOO_LARGE");
    start = end + 1;
  }
  return states;
}
function parseMachineState(output, expectedMachineId) {
  const text = utf8Text(output);
  let state;
  try {
    state = JSON.parse(text);
    if (!state || typeof state !== "object" || Array.isArray(state) || state.machineId !== expectedMachineId) throw new TypeError("Invalid machine state");
    if (!state.entries || typeof state.entries !== "object" || Array.isArray(state.entries)) {
      throw new TypeError("Invalid machine state entries");
    }
    if (Object.keys(state.entries).length > MAX_ENTRIES_PER_STATE) {
      throw remoteStateError("REMOTE_STATE_TOO_LARGE");
    }
    mergeMachineStates([state]);
  } catch (error) {
    if (error && SAFE_REMOTE_ERRORS.has(error)) throw error;
    throw remoteStateError("REMOTE_STATE_INVALID");
  }
  return state;
}
function countStateEntries(states) {
  const total = states.reduce((count, state) => count + Object.keys(state.entries).length, 0);
  if (total > MAX_TOTAL_STATE_ENTRIES) throw remoteStateError("REMOTE_STATE_TOO_LARGE");
}
async function readRemoteMachineStates(value, {
  execFile = nodeExecFile3,
  now = () => performance2.now()
} = {}) {
  let remote;
  try {
    remote = normalizeGitHubRemote(value);
  } catch {
    throw remoteStateError("INVALID_REPOSITORY_REMOTE");
  }
  const startedAt = now();
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_OPTIONAL_LOCKS: "0"
  };
  if (remote.transport === "ssh") {
    env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes -o ConnectTimeout=5";
  }
  const runGit = (args, { maxBuffer, tooLargeCode = "REMOTE_STATE_TOO_LARGE" } = {}) => new Promise((resolve, reject) => {
    const remaining = MAX_OPERATION_MS2 - (now() - startedAt);
    if (remaining <= 0) {
      reject(remoteStateError("GIT_TIMEOUT"));
      return;
    }
    execFile("git", args, {
      shell: false,
      encoding: "buffer",
      timeout: Math.max(1, Math.min(MAX_COMMAND_MS2, remaining)),
      maxBuffer,
      env
    }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ stdout: outputBuffer(stdout), stderr: outputBuffer(stderr) });
        return;
      }
      if (error.code === "ENOENT") reject(remoteStateError("GIT_NOT_INSTALLED"));
      else if (error.killed || error.code === "ETIMEDOUT") reject(remoteStateError("GIT_TIMEOUT"));
      else if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") reject(remoteStateError(tooLargeCode));
      else reject(remoteStateError("GIT_ACCESS_FAILED"));
    });
  });
  const refs = await runGit(["ls-remote", "--heads", remote.url], { maxBuffer: MAX_REF_OUTPUT_BYTES });
  if (refs.stdout.length === 0) return { empty: true, states: [] };
  let temporaryDirectory;
  try {
    temporaryDirectory = await mkdtemp2(path6.join(os2.tmpdir(), "openchamber-sync-read-"));
    const repositoryDirectory = path6.join(temporaryDirectory, "repository");
    const templateDirectory = path6.join(temporaryDirectory, "template");
    const hooksDirectory = path6.join(temporaryDirectory, "hooks");
    await Promise.all([mkdir3(templateDirectory), mkdir3(hooksDirectory)]);
    const gitConfig = ["-c", `core.hooksPath=${hooksDirectory}`, "-c", "core.fsmonitor=false", "-c", "fetch.fsckObjects=true"];
    await runGit([...gitConfig, "init", "--bare", "--quiet", `--template=${templateDirectory}`, repositoryDirectory], {
      maxBuffer: 256 * 1024
    });
    const localGit = (args, options) => runGit(["-C", repositoryDirectory, ...gitConfig, ...args], options);
    await localGit(["remote", "add", "origin", remote.url], { maxBuffer: 256 * 1024 });
    await localGit(["config", "extensions.partialClone", "origin"], { maxBuffer: 256 * 1024 });
    await localGit(["config", "remote.origin.promisor", "true"], { maxBuffer: 256 * 1024 });
    await localGit(["config", "remote.origin.partialclonefilter", "blob:none"], { maxBuffer: 256 * 1024 });
    const fetch = await localGit(["fetch", "--filter=blob:none", "--depth=1", "--no-tags", "--no-recurse-submodules", "origin", "HEAD"], {
      maxBuffer: 1024 * 1024
    });
    if (/filtering not recognized by server|filter(?:ing)?[^\n]*not supported/i.test(fetch.stderr.toString("utf8"))) {
      throw remoteStateError("REMOTE_FILTER_UNSUPPORTED");
    }
    const head = await localGit(["rev-parse", "--verify", "FETCH_HEAD^{commit}"], { maxBuffer: 4096 });
    const commit = utf8Text(head.stdout).trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit)) throw remoteStateError("REMOTE_STATE_INVALID");
    const tree = await localGit(["ls-tree", "-r", "-z", "--full-tree", commit, "--", "machines"], {
      maxBuffer: MAX_TREE_OUTPUT_BYTES
    });
    const machineFiles = parseMachineTree(tree.stdout);
    const states = [];
    let totalBytes = 0;
    for (const file of machineFiles) {
      const remainingBytes = MAX_TOTAL_STATE_BYTES - totalBytes;
      if (remainingBytes <= 0) throw remoteStateError("REMOTE_STATE_TOO_LARGE");
      const outputLimit = Math.min(MAX_STATE_BYTES2, remainingBytes) + 1;
      const blob = await localGit(["show", "--no-ext-diff", "--no-textconv", `${commit}:${file.relativePath}`], {
        maxBuffer: outputLimit
      });
      totalBytes += blob.stdout.length;
      if (blob.stdout.length > MAX_STATE_BYTES2 || totalBytes > MAX_TOTAL_STATE_BYTES) {
        throw remoteStateError("REMOTE_STATE_TOO_LARGE");
      }
      states.push(parseMachineState(blob.stdout, file.machineId));
      countStateEntries(states);
    }
    return { empty: false, states };
  } catch (error) {
    if (error && SAFE_REMOTE_ERRORS.has(error)) throw error;
    throw remoteStateError("GIT_ACCESS_FAILED");
  } finally {
    if (temporaryDirectory) await rm3(temporaryDirectory, { recursive: true, force: true }).catch(() => {
    });
  }
}

// src/repository-bootstrap.js
var REQUIRED_SOURCES = ["preferences", "opencode", "opencode-files", "extensions"];
function bootstrapError(code, message) {
  return Object.assign(new Error(message), { code });
}
function createRepositoryBootstrapState({ machineId, local, remote, now = Date.now() }) {
  if (!isValidMachineId(machineId)) throw new TypeError("Invalid machine id");
  if (!remote || typeof remote.empty !== "boolean" || !Array.isArray(remote.states)) {
    throw bootstrapError("REPOSITORY_NOT_EMPTY", "Repository bootstrap requires an empty repository");
  }
  if (remote.states.length !== 0) {
    throw bootstrapError("REPOSITORY_NOT_EMPTY", "Repository bootstrap requires a repository without machine state");
  }
  if (!local || !local.sources || !local.values || REQUIRED_SOURCES.some((source) => local.sources[source]?.status !== "ready")) {
    throw bootstrapError("LOCAL_SOURCES_UNAVAILABLE", "All portable local sources must be ready before bootstrap");
  }
  const state = createMachineState({ machineId, values: local.values, now });
  const content = `${JSON.stringify(JSON.parse(stableJson(state)), null, 2)}
`;
  return {
    branch: "main",
    path: `machines/${machineId}/state.json`,
    state,
    content
  };
}

// src/service.js
var MAX_REQUEST_BYTES = 4096;
var PREVIEW_ID_KEY = randomBytes2(32);
function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(body));
}
async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw Object.assign(new Error(), { code: "BODY_TOO_LARGE" });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function isRequestObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
async function parseRepositoryUrl(request) {
  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return { status: error?.code === "BODY_TOO_LARGE" ? 413 : 400, error: "invalid-request" };
  }
  if (!isRequestObject(body) || Object.keys(body).some((key) => key !== "url") || typeof body.url !== "string") {
    return { status: 400, error: "invalid-request" };
  }
  return { url: body.url };
}
function firstSyncPreviewError(error) {
  if (error?.code === "INVALID_REPOSITORY_REMOTE") return { status: 400, error: "invalid-repository-url" };
  if (error?.code === "INVALID_MACHINE_ID") return { status: 400, error: "invalid-machine-id" };
  if (error?.code === "GIT_NOT_INSTALLED") return { status: 503, error: "git-not-installed" };
  if (error?.code === "GIT_TIMEOUT") return { status: 504, error: "git-timeout" };
  if (error?.code === "REMOTE_STATE_TOO_LARGE") return { status: 413, error: "remote-state-too-large" };
  if (error?.code === "REMOTE_STATE_INVALID") return { status: 422, error: "remote-state-invalid" };
  if (error?.code === "REMOTE_FILTER_UNSUPPORTED") return { status: 422, error: "remote-state-unavailable" };
  if (error?.code === "GIT_ACCESS_FAILED") return { status: 422, error: "git-access-failed" };
  return { status: 503, error: "preview-unavailable" };
}
function bootstrapPushError(error) {
  const code = error?.code;
  if (code === "REPOSITORY_CHANGED" || code === "REPOSITORY_NOT_EMPTY") return { status: 409, error: "repository-changed" };
  if (code === "LOCAL_SOURCES_UNAVAILABLE") return { status: 422, error: "preview-not-confirmable" };
  if (code === "GIT_PUSH_FAILED") return { status: 422, error: "git-push-failed" };
  if (code === "STATE_TOO_LARGE") return { status: 413, error: "state-too-large" };
  return firstSyncPreviewError(error);
}
function applyError2(error) {
  const code = error?.code;
  if (code === "NOTHING_TO_APPLY") return { status: 422, error: "nothing-to-apply" };
  if (code === "INVALID_PLAN") return { status: 422, error: "preview-not-confirmable" };
  if (code === "APPLY_TARGET_UNAVAILABLE") return { status: 422, error: "apply-target-unavailable" };
  if (code === "APPLY_LIMIT_EXCEEDED") return { status: 413, error: "apply-too-large" };
  if (code === "APPLY_JOURNAL_INVALID") return { status: 503, error: "apply-recovery-required" };
  return { status: 500, error: "apply-failed" };
}
async function createFirstSyncReview(url, machineId, { openChamberDir: openChamberDir2, openCodeDir: openCodeDir2, stateReader }) {
  const normalizedRemote = normalizeGitHubRemote(url);
  if (machineId !== void 0 && !isValidMachineId(machineId)) {
    throw Object.assign(new Error("Invalid machine identity"), { code: "INVALID_MACHINE_ID" });
  }
  const remote = await stateReader(url);
  if (!remote || typeof remote.empty !== "boolean" || !Array.isArray(remote.states) || remote.empty && remote.states.length !== 0) {
    throw Object.assign(new Error("Invalid remote state"), { code: "REMOTE_STATE_INVALID" });
  }
  const local = await readLocalSnapshot({ openChamberDir: openChamberDir2, openCodeDir: openCodeDir2 });
  const comparison = createBootstrapPreview(local, remote.states);
  if (!machineId) comparison.canConfirm = false;
  const previewId = createHmac("sha256", PREVIEW_ID_KEY).update(stableJson({
    remote: normalizedRemote.url,
    machineId: machineId ?? null,
    empty: remote.empty,
    states: remote.states,
    local
  })).digest("hex");
  return {
    empty: remote.empty,
    remoteMachineCount: remote.states.length,
    machineIdentityReady: Boolean(machineId),
    machineRegistered: Boolean(machineId && remote.states.some((state) => state.machineId === machineId)),
    comparison,
    previewId,
    local,
    remote
  };
}
async function parseFirstSyncPreviewRequest(request) {
  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return { status: error?.code === "BODY_TOO_LARGE" ? 413 : 400, error: "invalid-request" };
  }
  if (!isRequestObject(body) || Object.keys(body).some((key) => !["url", "machineId"].includes(key)) || typeof body.url !== "string" || body.machineId !== void 0 && !isValidMachineId(body.machineId)) {
    return { status: 400, error: "invalid-request" };
  }
  return body;
}
async function parseConfirmationRequest(request) {
  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return { status: error?.code === "BODY_TOO_LARGE" ? 413 : 400, error: "invalid-request" };
  }
  const allowedKeys = /* @__PURE__ */ new Set(["url", "machineId", "previewId", "resolutions", "confirmed"]);
  if (!isRequestObject(body) || Object.keys(body).some((key) => !allowedKeys.has(key)) || typeof body.url !== "string" || !isValidMachineId(body.machineId) || typeof body.previewId !== "string" || !/^[a-f0-9]{64}$/.test(body.previewId) || typeof body.resolutions !== "string" || !/^[LR]{0,200}$/.test(body.resolutions) || body.confirmed !== true) {
    return { status: 400, error: "invalid-request" };
  }
  return body;
}
async function revalidateConfirmedPlan(parsed, { openChamberDir: openChamberDir2, openCodeDir: openCodeDir2, stateReader }) {
  const review = await createFirstSyncReview(parsed.url, parsed.machineId, { openChamberDir: openChamberDir2, openCodeDir: openCodeDir2, stateReader });
  if (review.previewId !== parsed.previewId) {
    return { errorStatus: 409, error: "preview-stale" };
  }
  const conflicts = review.comparison.items.filter((item) => item.action === "conflict");
  if (!review.comparison.canConfirm || parsed.resolutions.length !== conflicts.length) {
    return { errorStatus: 422, error: "preview-not-confirmable" };
  }
  return { review };
}
function createServiceServer({
  token: token2,
  openChamberDir: openChamberDir2,
  openCodeDir: openCodeDir2,
  gitProbe = probeGitHubRepo,
  stateReader = readRemoteMachineStates,
  repositoryPusher = pushBootstrapState,
  applyWriter = applyPlanToFiles
}) {
  if (typeof token2 !== "string" || token2.length === 0) {
    throw new TypeError("A service token is required");
  }
  return http.createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token2}`) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }
    let pathname;
    try {
      pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      sendJson(response, 400, { error: "bad-request" });
      return;
    }
    if (request.method === "GET" && pathname === "/health") {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && pathname === "/preview") {
      try {
        sendJson(response, 200, await createLocalPreview({ openChamberDir: openChamberDir2, openCodeDir: openCodeDir2 }));
      } catch {
        sendJson(response, 503, { error: "preview-unavailable" });
      }
      return;
    }
    if (request.method === "POST" && pathname === "/repository/preview") {
      const parsed = await parseFirstSyncPreviewRequest(request);
      if (parsed.error) {
        sendJson(response, parsed.status, { error: parsed.error });
        return;
      }
      try {
        const review = await createFirstSyncReview(parsed.url, parsed.machineId, { openChamberDir: openChamberDir2, openCodeDir: openCodeDir2, stateReader });
        sendJson(response, 200, {
          empty: review.empty,
          remoteMachineCount: review.remoteMachineCount,
          machineIdentityReady: review.machineIdentityReady,
          machineRegistered: review.machineRegistered,
          comparison: review.comparison,
          previewId: review.previewId
        });
      } catch (error) {
        const failure = firstSyncPreviewError(error);
        sendJson(response, failure.status, { error: failure.error });
      }
      return;
    }
    if (request.method === "POST" && pathname === "/repository/confirm") {
      const parsed = await parseConfirmationRequest(request);
      if (parsed.error) {
        sendJson(response, parsed.status, { error: parsed.error });
        return;
      }
      try {
        const result = await revalidateConfirmedPlan(parsed, { openChamberDir: openChamberDir2, openCodeDir: openCodeDir2, stateReader });
        if (result.error) {
          sendJson(response, result.errorStatus, { error: result.error });
          return;
        }
        const review = result.review;
        if (review.remote.states.length === 0) {
          const bootstrap = createRepositoryBootstrapState({
            machineId: parsed.machineId,
            local: review.local,
            remote: review.remote
          });
          sendJson(response, 200, {
            confirmed: true,
            changesMade: false,
            bootstrap: {
              branch: bootstrap.branch,
              path: bootstrap.path,
              entryCount: Object.keys(bootstrap.state.entries).length
            }
          });
        } else {
          sendJson(response, 200, { confirmed: true, changesMade: false });
        }
      } catch (error) {
        const failure = firstSyncPreviewError(error);
        sendJson(response, failure.status, { error: failure.error });
      }
      return;
    }
    if (request.method === "POST" && pathname === "/repository/bootstrap") {
      const parsed = await parseConfirmationRequest(request);
      if (parsed.error) {
        sendJson(response, parsed.status, { error: parsed.error });
        return;
      }
      try {
        const result = await revalidateConfirmedPlan(parsed, { openChamberDir: openChamberDir2, openCodeDir: openCodeDir2, stateReader });
        if (result.error) {
          sendJson(response, result.errorStatus, { error: result.error });
          return;
        }
        const review = result.review;
        if (review.remote.states.length !== 0) {
          sendJson(response, 409, { error: "repository-changed" });
          return;
        }
        const now = Date.now();
        const bootstrap = createRepositoryBootstrapState({
          machineId: parsed.machineId,
          local: review.local,
          remote: review.remote,
          now
        });
        const pushed = await repositoryPusher({
          url: parsed.url,
          branch: bootstrap.branch,
          path: bootstrap.path,
          content: bootstrap.content,
          commitTimestamp: now
        });
        if (!pushed || pushed.branch !== bootstrap.branch || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(pushed.commit ?? "")) {
          throw Object.assign(new Error("Invalid push result"), { code: "GIT_PUSH_FAILED" });
        }
        sendJson(response, 200, {
          confirmed: true,
          changesMade: true,
          bootstrap: {
            branch: bootstrap.branch,
            path: bootstrap.path,
            entryCount: Object.keys(bootstrap.state.entries).length
          },
          commit: pushed.commit
        });
      } catch (error) {
        const failure = bootstrapPushError(error);
        sendJson(response, failure.status, { error: failure.error });
      }
      return;
    }
    if (request.method === "POST" && pathname === "/repository/apply") {
      const parsed = await parseConfirmationRequest(request);
      if (parsed.error) {
        sendJson(response, parsed.status, { error: parsed.error });
        return;
      }
      try {
        const result = await revalidateConfirmedPlan(parsed, { openChamberDir: openChamberDir2, openCodeDir: openCodeDir2, stateReader });
        if (result.error) {
          sendJson(response, result.errorStatus, { error: result.error });
          return;
        }
        const review = result.review;
        if (review.remote.empty) {
          sendJson(response, 422, { error: "nothing-to-apply" });
          return;
        }
        const remote = mergeMachineStates(review.remote.states);
        const plan = planApplyChanges({
          items: review.comparison.items,
          remoteValues: remote.values,
          tombstones: remote.tombstones,
          resolutions: parsed.resolutions
        });
        const planId = createHash2("sha256").update(stableJson(plan)).digest("hex");
        const applied = await applyWriter(plan, {
          openChamberDir: openChamberDir2,
          openCodeDir: openCodeDir2,
          journalPath: defaultApplyJournalPath(openChamberDir2),
          planId
        });
        sendJson(response, 200, {
          confirmed: true,
          changesMade: true,
          applied: applied.applied,
          recovered: applied.recovered === true
        });
      } catch (error) {
        const failure = applyError2(error);
        sendJson(response, failure.status, { error: failure.error });
      }
      return;
    }
    if (request.method === "POST" && pathname === "/repository/test") {
      const parsed = await parseRepositoryUrl(request);
      if (parsed.error) {
        sendJson(response, parsed.status, { error: parsed.error });
        return;
      }
      try {
        const result = await gitProbe(parsed.url);
        sendJson(response, 200, { accessible: true, repository: result.repository, url: result.url });
      } catch (error) {
        const code = error?.code;
        const status = code === "INVALID_REPOSITORY_REMOTE" ? 400 : code === "GIT_NOT_INSTALLED" ? 503 : code === "GIT_TIMEOUT" ? 504 : 422;
        const publicCode = code === "INVALID_REPOSITORY_REMOTE" ? "invalid-repository-url" : code === "GIT_NOT_INSTALLED" ? "git-not-installed" : code === "GIT_TIMEOUT" ? "git-timeout" : "git-access-failed";
        const diagnostics = sanitizeRepositoryDiagnostics(error?.diagnostics);
        sendJson(response, status, { error: publicCode, ...diagnostics ? { diagnostics } : {} });
      }
      return;
    }
    sendJson(response, 404, { error: "not-found" });
  });
}

// src/service-entry.js
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var token = process.env.OPENCHAMBER_SERVICE_TOKEN;
if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) {
  process.exit(1);
}
var home = homedir();
var openChamberDir = process.env.OPENCHAMBER_DATA_DIR || path7.join(home, ".config", "openchamber");
var openCodeDir = process.env.OPENCODE_CONFIG_DIR || path7.join(home, ".config", "opencode");
createServiceServer({ token, openChamberDir, openCodeDir }).listen(port, "127.0.0.1");
