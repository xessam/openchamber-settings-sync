import { homedir } from 'node:os';
import path from 'node:path';

import { createServiceServer } from './service.js';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN;
if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) {
  process.exit(1);
}

const home = homedir();
const openChamberDir = process.env.OPENCHAMBER_DATA_DIR
  || path.join(home, '.config', 'openchamber');
const openCodeDir = process.env.OPENCODE_CONFIG_DIR
  || path.join(home, '.config', 'opencode');

createServiceServer({ token, openChamberDir, openCodeDir })
  .listen(port, '127.0.0.1');
