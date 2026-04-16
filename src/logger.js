'use strict';

// Structured JSON logger — replaces all console.log/warn/error calls.
// Output format: {"ts":"ISO","level":"info","msg":"...","...extra"}
// console.error is preserved only for crash handlers (non-JSON scenarios).

function _write(level, msg, extra) {
  const entry = { ts: new Date().toISOString(), level, msg };
  if (extra && typeof extra === 'object') {
    Object.assign(entry, extra);
  } else if (extra !== undefined) {
    entry.extra = extra;
  }
  // Use process.stdout directly for info/warn to keep output clean.
  // Use process.stderr for errors so they can be separated by shell redirection.
  const line = JSON.stringify(entry);
  if (level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

function log(msg, extra) {
  _write('info', msg, extra);
}

function warn(msg, extra) {
  _write('warn', msg, extra);
}

function error(msg, extra) {
  _write('error', msg, extra);
}

module.exports = { log, warn, error };
