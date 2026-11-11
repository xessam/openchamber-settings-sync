export async function runRepositoryProbe(serviceRequest, url, onReady = () => {}) {
  const health = await serviceRequest({ method: 'GET', path: '/health' });
  if (health.status !== 200) {
    throw Object.assign(new Error('Local service is not ready'), { code: 'SERVICE_NOT_READY' });
  }

  onReady();
  return serviceRequest({ method: 'POST', path: '/repository/test', body: JSON.stringify({ url }) });
}

export async function runFirstSyncPreview(serviceRequest, url, { machineId, onReady = () => {} } = {}) {
  const health = await serviceRequest({ method: 'GET', path: '/health' });
  if (health.status !== 200) {
    throw Object.assign(new Error('Local service is not ready'), { code: 'SERVICE_NOT_READY' });
  }

  onReady();
  return serviceRequest({
    method: 'POST',
    path: '/repository/preview',
    body: JSON.stringify({ url, ...(machineId ? { machineId } : {}) }),
  });
}

export async function runFirstSyncConfirmation(serviceRequest, { url, machineId, previewId, resolutions, confirmed }, onReady = () => {}) {
  const health = await serviceRequest({ method: 'GET', path: '/health' });
  if (health.status !== 200) {
    throw Object.assign(new Error('Local service is not ready'), { code: 'SERVICE_NOT_READY' });
  }

  onReady();
  return serviceRequest({
    method: 'POST',
    path: '/repository/confirm',
    body: JSON.stringify({ url, machineId, previewId, resolutions, confirmed }),
  });
}

export async function runRepositoryBootstrap(serviceRequest, { url, machineId, previewId, resolutions, confirmed }, onReady = () => {}) {
  const health = await serviceRequest({ method: 'GET', path: '/health' });
  if (health.status !== 200) {
    throw Object.assign(new Error('Local service is not ready'), { code: 'SERVICE_NOT_READY' });
  }

  onReady();
  return serviceRequest({
    method: 'POST',
    path: '/repository/bootstrap',
    body: JSON.stringify({ url, machineId, previewId, resolutions, confirmed }),
  });
}

export async function runRepositoryApply(serviceRequest, { url, machineId, previewId, resolutions, confirmed }, onReady = () => {}) {
  const health = await serviceRequest({ method: 'GET', path: '/health' });
  if (health.status !== 200) {
    throw Object.assign(new Error('Local service is not ready'), { code: 'SERVICE_NOT_READY' });
  }

  onReady();
  return serviceRequest({
    method: 'POST',
    path: '/repository/apply',
    body: JSON.stringify({ url, machineId, previewId, resolutions, confirmed }),
  });
}
