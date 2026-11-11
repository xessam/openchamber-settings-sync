import test from 'node:test';
import assert from 'node:assert/strict';

import { canConfirmFirstSync } from '../src/first-sync-confirmation.js';

const preview = {
  canConfirm: true,
  items: [
    { key: 'preferences.darkThemeId', action: 'conflict' },
    { key: 'opencodeFile.kYWdlbnRzL3Jldmlldy5tZA', action: 'upload' },
  ],
};

test('requires explicit acknowledgement and a choice for every conflict', () => {
  assert.equal(canConfirmFirstSync(preview, { 'preferences.darkThemeId': 'local' }, false), false);
  assert.equal(canConfirmFirstSync(preview, {}, true), false);
  assert.equal(canConfirmFirstSync(preview, { 'preferences.darkThemeId': 'local' }, true), true);
  assert.equal(canConfirmFirstSync(preview, { 'preferences.darkThemeId': 'remote' }, true), true);
});

test('never enables confirmation for blocked, incomplete, or invalid choices', () => {
  assert.equal(canConfirmFirstSync({ ...preview, canConfirm: false }, { 'preferences.darkThemeId': 'local' }, true), false);
  assert.equal(canConfirmFirstSync(preview, { 'preferences.darkThemeId': 'maybe' }, true), false);
  assert.equal(canConfirmFirstSync(null, {}, true), false);
});
