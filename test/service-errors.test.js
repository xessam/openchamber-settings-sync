import test from 'node:test';
import assert from 'node:assert/strict';

import { repositoryServiceErrorMessage } from '../src/service-errors.js';

test('explains service approval and startup failures using safe public codes', () => {
  assert.match(repositoryServiceErrorMessage({ code: 'NO_SERVICE' }), /service.*approved/i);
  assert.match(repositoryServiceErrorMessage({ code: 'DISABLED' }), /paused/i);
  assert.match(repositoryServiceErrorMessage({ code: 'SERVICE_FAILED' }), /failed to start/i);
  assert.match(repositoryServiceErrorMessage({ code: 'REQUEST_FAILED' }), /did not return a response/i);
});

test('does not expose raw exception messages in the UI', () => {
  const message = repositoryServiceErrorMessage(Object.assign(new Error('credential token must stay private'), {
    code: 'UNKNOWN_INTERNAL_CODE',
  }));

  assert.match(message, /service request failed/i);
  assert.doesNotMatch(message, /credential|token|private/i);
});
