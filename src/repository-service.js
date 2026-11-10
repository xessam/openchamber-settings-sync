export async function runRepositoryProbe(serviceRequest, url, onReady = () => {}) {
  const health = await serviceRequest({ method: 'GET', path: '/health' });
  if (health.status !== 200) {
    throw Object.assign(new Error('Local service is not ready'), { code: 'SERVICE_NOT_READY' });
  }

  onReady();
  return serviceRequest({ method: 'POST', path: '/repository/test', body: { url } });
}
