import { isValidMachineId } from './state.js';

const STORAGE_KEY = 'machineId';
const LOCK_NAME = 'openchamber-sync-machine-id';

function identityError(code, message) {
  return Object.assign(new Error(message), { code });
}

export async function getOrCreateMachineId({ storage, deviceStorageAvailable, lockManager, randomUUID } = {}) {
  if (deviceStorageAvailable !== true) {
    throw identityError('DEVICE_STORAGE_UNAVAILABLE', 'Device-scoped extension storage is unavailable');
  }
  if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function') {
    throw identityError('MACHINE_ID_STORAGE_UNAVAILABLE', 'Device identity storage is unavailable');
  }
  if (!lockManager || typeof lockManager.request !== 'function') {
    throw identityError('DEVICE_IDENTITY_LOCK_UNAVAILABLE', 'Could not safely initialize the device identity');
  }

  return lockManager.request(LOCK_NAME, { mode: 'exclusive' }, async () => {
    const stored = await storage.get(STORAGE_KEY, { scope: 'device' });
    if (isValidMachineId(stored)) return stored;

    const generate = randomUUID ?? (() => globalThis.crypto?.randomUUID?.());
    const machineId = generate();
    if (!isValidMachineId(machineId)) {
      throw identityError('MACHINE_ID_INVALID', 'Could not create a valid device identity');
    }
    await storage.set(STORAGE_KEY, machineId, { scope: 'device' });
    const persisted = await storage.get(STORAGE_KEY, { scope: 'device' });
    if (!isValidMachineId(persisted)) {
      throw identityError('MACHINE_ID_STORAGE_FAILED', 'Could not persist the device identity');
    }
    return persisted;
  });
}
