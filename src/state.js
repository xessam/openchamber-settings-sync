const MACHINE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const KEY_PATH = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*){0,8}$/;
const BLOCKED_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);
const STATE_KEYS = new Set(['version', 'machineId', 'sequence', 'entries']);

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isValidMachineId(machineId) {
  return typeof machineId === 'string' && MACHINE_ID.test(machineId);
}

function assertMachineId(machineId) {
  if (!isValidMachineId(machineId)) {
    throw new TypeError('Invalid machine id');
  }
}

function assertKeyPath(keyPath) {
  if (typeof keyPath !== 'string' || !KEY_PATH.test(keyPath)
    || keyPath.split('.').some((segment) => BLOCKED_SEGMENTS.has(segment.toLowerCase()))) {
    throw new TypeError('Invalid sync key path');
  }
}

function canonicalize(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('Sync values must not contain cycles');
    seen.add(value);
    const result = value.map((item) => canonicalize(item, seen));
    seen.delete(value);
    return result;
  }
  if (!isRecord(value)) throw new TypeError('Sync values must be JSON-compatible');
  if (seen.has(value)) throw new TypeError('Sync values must not contain cycles');
  seen.add(value);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (BLOCKED_SEGMENTS.has(key.toLowerCase())) throw new TypeError('Unsafe sync value key');
    result[key] = canonicalize(value[key], seen);
  }
  seen.delete(value);
  return result;
}

export function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function validateMachineState(state) {
  if (!isRecord(state) || state.version !== 1 || !isRecord(state.entries)
    || !Number.isSafeInteger(state.sequence) || state.sequence < 0) {
    throw new TypeError('Invalid machine state');
  }
  if (Object.keys(state).some((key) => !STATE_KEYS.has(key))) {
    throw new TypeError('Invalid machine state');
  }
  assertMachineId(state.machineId);

  for (const [keyPath, entry] of Object.entries(state.entries)) {
    assertKeyPath(keyPath);
    if (!isRecord(entry)
      || !Number.isSafeInteger(entry.timestamp) || entry.timestamp < 0
      || !Number.isSafeInteger(entry.sequence) || entry.sequence < 1
      || entry.sequence > state.sequence) {
      throw new TypeError('Invalid machine state entry');
    }
    const allowedKeys = new Set(['timestamp', 'sequence', 'deleted', 'value']);
    if (Object.keys(entry).some((key) => !allowedKeys.has(key))) {
      throw new TypeError('Invalid machine state entry');
    }
    if (entry.deleted === true) {
      if (Object.hasOwn(entry, 'value')) throw new TypeError('Invalid machine state tombstone');
    } else if (entry.deleted !== undefined || !Object.hasOwn(entry, 'value')) {
      throw new TypeError('Invalid machine state value');
    } else {
      canonicalize(entry.value);
    }
  }
  return state;
}

export function createMachineState({ machineId, previous, values, now = Date.now() }) {
  assertMachineId(machineId);
  if (!isRecord(values)) throw new TypeError('Expected sync values object');
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('Invalid sync timestamp');

  const oldState = previous === undefined ? undefined : validateMachineState(previous);
  if (oldState && oldState.machineId !== machineId) throw new TypeError('Machine state belongs to another machine');
  const cleanValues = {};
  for (const [keyPath, value] of Object.entries(values)) {
    assertKeyPath(keyPath);
    cleanValues[keyPath] = canonicalize(value);
  }

  const entries = { ...(oldState?.entries ?? {}) };
  let sequence = oldState?.sequence ?? 0;
  const nextSequence = () => {
    if (!Number.isSafeInteger(sequence + 1)) throw new RangeError('Machine state sequence exhausted');
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

export function mergeMachineStates(states) {
  if (!Array.isArray(states)) throw new TypeError('Expected machine states array');
  const winners = new Map();
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
