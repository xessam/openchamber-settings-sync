// src/service-entry.js
import { homedir } from "node:os";
import path2 from "node:path";

// src/service.js
import http from "node:http";

// src/local-preview.js
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

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
  if (!/^https?:\/\//i.test(value)) return value;
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
    return changed ? url.toString() : value;
  } catch {
    return value;
  }
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

// src/local-preview.js
var MAX_CONFIG_BYTES = 2 * 1024 * 1024;
async function readJsonFile(filePath) {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
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
  const [preferences, opencode, extensions] = await Promise.all([
    sourcePreview(path.join(openChamberDir2, "preferences.json"), "preferences", (value) => Object.keys(selectPortablePreferences(value).fields).length),
    sourcePreview(path.join(openCodeDir2, "opencode.json"), "opencode", (value) => Object.keys(sanitizeOpenCodeConfig(value)).length),
    sourcePreview(path.join(openChamberDir2, "extensions.json"), "extensions", (value) => selectExtensionRepositories(value).length)
  ]);
  return { sources: [preferences, opencode, extensions] };
}

// src/service.js
function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(body));
}
function createServiceServer({ token: token2, openChamberDir: openChamberDir2, openCodeDir: openCodeDir2 }) {
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
var openChamberDir = process.env.OPENCHAMBER_DATA_DIR || path2.join(home, ".config", "openchamber");
var openCodeDir = process.env.OPENCODE_CONFIG_DIR || path2.join(home, ".config", "opencode");
createServiceServer({ token, openChamberDir, openCodeDir }).listen(port, "127.0.0.1");
