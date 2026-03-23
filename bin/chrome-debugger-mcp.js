#!/usr/bin/env node

import { startServer } from '../build/src/index.js';

const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const port = portIndex !== -1 && args[portIndex + 1]
  ? parseInt(args[portIndex + 1], 10)
  : undefined;

if (port !== undefined && (isNaN(port) || port < 1 || port > 65535)) {
  console.error('Error: --port must be a valid port number (1-65535)');
  process.exit(1);
}

startServer({ port }).catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
