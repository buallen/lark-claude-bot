'use strict';

const { spawn } = require('child_process');
const fs        = require('fs');
const path      = require('path');

const {
  CLAUDE_TIMEOUT_MS,
  SIGKILL_GRACE_MS,
  STDERR_CAP,
} = require('../constants');
const logger = require('../logger');

// ── NVM path discovery ────────────────────────────────────────────────────────
// Resolves node + claude cli.js from nvm (works under launchd where nvm is not in PATH).

const NVM_NODE = (() => {
  const nvmBase = path.join(process.env.HOME, '.nvm', 'versions', 'node');
  try {
    const versions = fs.readdirSync(nvmBase).sort().reverse();
    for (const v of versions) {
      const p = path.join(nvmBase, v, 'bin', 'node');
      if (fs.existsSync(p)) return p;
    }
  } catch (_) {}
  return process.execPath;
})();

const CLAUDE_CLI = (() => {
  const nvmBase = path.join(process.env.HOME, '.nvm', 'versions', 'node');
  try {
    const versions = fs.readdirSync(nvmBase).sort().reverse();
    for (const v of versions) {
      const cli = path.join(nvmBase, v, 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
      if (fs.existsSync(cli)) return cli;
    }
  } catch (_) {}
  return null;
})();

const NVM_BIN = path.dirname(NVM_NODE);

/**
 * Run Claude CLI in a subprocess.
 * @param {string}   prompt
 * @param {string}   workdir
 * @param {string|null} sessionId  — resume an existing session if provided
 * @param {Function} onProgress   — called with accumulated stream text on each chunk
 * @param {Function} onSpawn      — called immediately after spawn with the child process
 * @returns {Promise<{result: string, sessionId: string|null}>}
 */
function runClaude(prompt, workdir, sessionId, onProgress, onSpawn) {
  return new Promise((resolve, reject) => {
    if (!CLAUDE_CLI) return reject(new Error('claude cli.js not found'));

    const env = {
      ...process.env,
      PATH:        `${NVM_BIN}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
      HOME:        process.env.HOME,
      TERM:        'xterm-256color',
      FORCE_COLOR: '0',
    };

    const args = [
      CLAUDE_CLI,
      '-p', prompt,
      '--dangerously-skip-permissions',
      '--output-format', 'stream-json',
      '--verbose',
    ];
    if (sessionId) args.push('--resume', sessionId);

    let finalText      = '';
    let streamText     = '';
    let finalSessionId = null;
    let stderr         = '';
    let buf            = '';

    const proc = spawn(NVM_NODE, args, { cwd: workdir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    if (onSpawn) onSpawn(proc);

    proc.stdout.on('data', d => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const ev = JSON.parse(trimmed);
          if (ev.type === 'assistant' && ev.message?.content) {
            for (const block of ev.message.content) {
              if (block.type === 'text') {
                streamText += block.text;
                if (onProgress) onProgress(streamText);
              }
            }
          }
          if (ev.type === 'result') {
            if (ev.result)     finalText      = ev.result;
            if (ev.session_id) finalSessionId = ev.session_id;
          }
        } catch (_) {}
      }
    });

    proc.stderr.on('data', d => {
      stderr += d.toString();
      if (stderr.length > STDERR_CAP) stderr = stderr.slice(-STDERR_CAP);
    });

    let killTimer = null;
    const timer   = setTimeout(() => {
      proc.kill('SIGTERM');
      killTimer = setTimeout(() => {
        proc.kill('SIGKILL');
        logger.warn('[claude] SIGKILL sent after SIGTERM timeout', { pid: proc.pid });
      }, SIGKILL_GRACE_MS);
      reject(new Error('Timed out after 10 minutes'));
    }, CLAUDE_TIMEOUT_MS);

    proc.on('close', code => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (code === 0) {
        resolve({
          result:    finalText.trim() || streamText.trim() || '✅ Done (no output)',
          sessionId: finalSessionId,
        });
      } else {
        reject(new Error(stderr.trim() || streamText.trim() || `Claude exited with code ${code}`));
      }
    });

    proc.on('error', err => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });
  });
}

module.exports = { runClaude, NVM_NODE, CLAUDE_CLI, NVM_BIN };
