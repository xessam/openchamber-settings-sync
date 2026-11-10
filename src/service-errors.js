const MESSAGES = {
  NO_SERVICE: 'The local service is not approved or available. Check Settings → Extensions and reopen the panel.',
  DISABLED: 'OpenChamber Sync is paused. Resume it in Settings → Extensions and retry.',
  SERVICE_FAILED: 'The local service failed to start. Reopen the panel; if this continues, reinstall the current extension build.',
  SERVICE_NOT_READY: 'The local service did not become ready. Reopen the panel and retry.',
  REQUEST_FAILED: 'The local service did not return a response. Reopen the extension and retry.',
  HOST_TIMEOUT: 'OpenChamber did not answer the service request in time. Retry the Git access test.',
  HOST_UNAVAILABLE: 'The panel is not connected to OpenChamber. Reopen it from the Extensions list.',
};

export function repositoryServiceErrorMessage(error) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && MESSAGES[code]
    ? MESSAGES[code]
    : 'The local service request failed. Retry the Git access test from the extension panel.';
}
