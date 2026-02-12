// Startup wrapper — catches and logs any crash before exit
console.log('[start] Node', process.version, '| Platform:', process.platform, process.arch);
console.log('[start] Loading server...');

process.on('uncaughtException', (err) => {
  console.error('[CRASH] Uncaught exception:', err.stack || err);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('[CRASH] Unhandled rejection:', err);
  process.exit(1);
});

import('./dist/index.js').catch((err) => {
  console.error('[CRASH] Failed to load server module:', err.stack || err);
  process.exit(1);
});
