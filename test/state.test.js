import test from 'node:test';
import assert from 'node:assert/strict';

import { createMachineState, mergeMachineStates } from '../src/state.js';

test('records changed values and deletions with per-machine ordering', () => {
  const initial = createMachineState({
    machineId: 'laptop-a',
    values: { 'openchamber.preferences.darkThemeId': 'night', 'opencode.provider': { model: 'm1' } },
    now: 100,
  });
  const next = createMachineState({
    machineId: 'laptop-a',
    previous: initial,
    values: { 'openchamber.preferences.darkThemeId': 'night', 'opencode.provider': { model: 'm2' } },
    now: 101,
  });

  assert.equal(next.entries['openchamber.preferences.darkThemeId'].timestamp, 100);
  assert.equal(next.entries['opencode.provider'].timestamp, 101);
  assert.deepEqual(next.entries['openchamber.preferences.darkThemeId'], initial.entries['openchamber.preferences.darkThemeId']);
  assert.equal(next.entries['opencode.provider'].value.model, 'm2');
  assert.equal(next.sequence, 3);
});

test('a later tombstone wins over stale values without resurrecting the key', () => {
  const laptop = createMachineState({ machineId: 'laptop', values: { favorite: 'model-a' }, now: 10 });
  const desktop = createMachineState({
    machineId: 'desktop',
    values: { favorite: 'model-a' },
    now: 10,
  });
  const deleted = createMachineState({ machineId: 'laptop', previous: laptop, values: {}, now: 20 });

  const merged = mergeMachineStates([desktop, deleted]);
  assert.deepEqual(merged.values, {});
  assert.deepEqual(merged.tombstones, ['favorite']);
});

test('merges independent keys and resolves equal timestamps deterministically', () => {
  const first = createMachineState({ machineId: 'machine-a', values: { theme: 'dark', font: 'mono' }, now: 5 });
  const second = createMachineState({ machineId: 'machine-b', values: { theme: 'light' }, now: 5 });

  assert.deepEqual(mergeMachineStates([first, second]).values, { font: 'mono', theme: 'light' });
  assert.deepEqual(mergeMachineStates([second, first]).values, { font: 'mono', theme: 'light' });
});

test('uses the per-machine sequence to order writes within one timestamp', () => {
  const first = createMachineState({ machineId: 'machine-a', values: { theme: 'dark' }, now: 5 });
  const second = createMachineState({ machineId: 'machine-a', previous: first, values: { theme: 'light' }, now: 5 });

  assert.deepEqual(mergeMachineStates([first, second]).values, { theme: 'light' });
});

test('rejects invalid machine identifiers, paths, and untrusted state shapes', () => {
  assert.throws(() => createMachineState({ machineId: '../machine', values: {}, now: 1 }), /machine id/i);
  assert.throws(() => createMachineState({ machineId: 'laptop', values: { '__proto__.polluted': true }, now: 1 }), /key path/i);
  assert.throws(() => mergeMachineStates([{ version: 2 }]), /machine state/i);
});
