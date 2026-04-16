'use strict';

const fs   = require('fs');
const path = require('path');

const { TMP_FILE_CLEANUP_MS } = require('./constants');
const logger = require('./logger');

const STATE_FILE     = path.join(__dirname, '..', '.state.json');
const DEFAULT_WORKDIR = process.env.WORKDIR || '/Users/kan.lu/Documents/GitHub';

// In-memory per-user state
const userState = new Map();

function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(data)) {
      userState.set(k, {
        workdir:      v.workdir || DEFAULT_WORKDIR,
        sessionId:    v.sessionId || null,
        running:      false,          // never persist running=true across restarts
        pendingMsgId: v.pendingMsgId || null,
        claudeProc:   null,           // in-memory only
      });
    }
    logger.log('[state] loaded users', { count: userState.size, file: STATE_FILE });
  } catch (_) {}
}

// Async write — does not block the event loop
function saveState() {
  const data = {};
  for (const [k, v] of userState.entries()) {
    data[k] = { workdir: v.workdir, sessionId: v.sessionId, pendingMsgId: v.pendingMsgId || null };
  }
  fs.promises.writeFile(STATE_FILE, JSON.stringify(data, null, 2)).catch(e => {
    logger.error('[state] save error', { msg: e.message });
  });
}

function getState(openId) {
  if (!userState.has(openId)) {
    userState.set(openId, {
      workdir:      DEFAULT_WORKDIR,
      sessionId:    null,
      running:      false,
      pendingMsgId: null,
      claudeProc:   null,
    });
  }
  return userState.get(openId);
}

// Lazy-require to avoid circular dependency: state → messages → state
async function cleanupPendingMessages() {
  const pending = [...userState.entries()].filter(([, s]) => s.pendingMsgId);
  if (pending.length === 0) return;
  logger.log('[startup] cleaning up abandoned placeholders', { count: pending.length });
  // Lazy-require here to break the circular dependency chain
  const { patchMsg } = require('./lark/messages');
  for (const [, state] of pending) {
    const msgId = state.pendingMsgId;
    state.pendingMsgId = null;
    saveState();
    try {
      await patchMsg(msgId, '⚠️ _Bot restarted — previous response was lost. Please resend your message._');
      logger.log('[startup] patched abandoned placeholder', { msgId });
    } catch (e) {
      logger.warn('[startup] failed to patch abandoned placeholder', { msgId, msg: e?.message });
    }
  }
}

// Scan known workdirs for temp images left by a previous crash
async function cleanupStaleImages() {
  const workdirs = new Set([DEFAULT_WORKDIR, ...[...userState.values()].map(s => s.workdir)]);
  const now = Date.now();
  for (const dir of workdirs) {
    try {
      const files = await fs.promises.readdir(dir);
      for (const f of files) {
        if (!f.startsWith('lark_img_')) continue;
        const fp = path.join(dir, f);
        try {
          const stat = await fs.promises.stat(fp);
          if (now - stat.mtimeMs > TMP_FILE_CLEANUP_MS) {
            await fs.promises.unlink(fp);
            logger.log('[startup] removed stale temp image', { file: fp });
          }
        } catch (_) {}
      }
    } catch (_) {}
  }
}

module.exports = {
  userState,
  loadState,
  saveState,
  getState,
  cleanupPendingMessages,
  cleanupStaleImages,
  DEFAULT_WORKDIR,
};
