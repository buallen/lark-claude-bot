'use strict';

// Catch all unhandled errors so the process doesn't silently die.
// These handlers intentionally use console.error (not logger) because
// logger itself may not be initialised at the time of a crash.
process.on('uncaughtException', (err) => {
  console.error('[CRASH uncaughtException]', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[CRASH unhandledRejection]', reason);
});

require('./src/bot');
