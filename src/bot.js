'use strict';

// ── Environment bootstrap (must happen before any module that reads env vars) ─
const fs   = require('fs');
const path = require('path');

// Load .env if present (before other requires so env is populated)
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  });
}

// ── Single-instance PID lock ──────────────────────────────────────────────────
const LOCK_FILE = path.join(__dirname, '..', '.bot.pid');

const existingPid = (() => {
  try {
    const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
    if (pid && pid !== process.pid) {
      try { process.kill(pid, 0); return pid; } catch (_) { return null; }
    }
  } catch (_) {}
  return null;
})();

if (existingPid) {
  // Use process.stderr directly here — logger may not be ready yet
  process.stderr.write(`[startup] Another instance is already running (PID ${existingPid}). Exiting.\n`);
  process.exit(1);
}

fs.writeFileSync(LOCK_FILE, String(process.pid));
process.on('exit', () => { try { fs.unlinkSync(LOCK_FILE); } catch (_) {} });

// ── Validate required env vars ────────────────────────────────────────────────
const APP_ID     = process.env.LARK_APP_ID;
const APP_SECRET = process.env.LARK_APP_SECRET;

if (!APP_ID || !APP_SECRET) {
  process.stderr.write('Missing LARK_APP_ID or LARK_APP_SECRET environment variables.\n');
  process.exit(1);
}

// ── Module imports (after env is ready) ──────────────────────────────────────
const lark = require('@larksuiteoapi/node-sdk');

const logger               = require('./logger');
const {
  MSG_AGE_LIMIT_MS,
  TMP_FILE_CLEANUP_MS,
  STREAM_TIMER_MS,
  STREAM_PREVIEW_CHARS,
  TIMER_FAIL_THRESHOLD,
  MAX_INPUT_LENGTH,
}                          = require('./constants');
const { userState, loadState, saveState, getState, cleanupPendingMessages, cleanupStaleImages } = require('./state');
const { processedMsgIds, loadDedup, saveDedup }  = require('./dedup');
const { checkRateLimit }   = require('./ratelimit');
const { startHealthServer }= require('./health');
const { reply, patchMsg, deliverResult }         = require('./lark/messages');
const { addReaction, removeReaction }            = require('./lark/reactions');
const { runClaude, NVM_NODE, CLAUDE_CLI }        = require('./claude/runner');
const { parseMessageContent }                    = require('./commands/parser');
const { handleBuiltinCommand }                   = require('./commands/handler');
const { MAX_PROCESSED_IDS }                      = require('./constants');

// ── Startup initialisation ────────────────────────────────────────────────────
loadDedup();
loadState();

cleanupPendingMessages().catch(e => logger.error('[startup] cleanup error', { msg: e.message }));
cleanupStaleImages().catch(() => {});

startHealthServer();

// Keep the event loop alive even if WS drops (LaunchAgent KeepAlive will restart)
const _keepAlive = setInterval(() => {}, 60_000);

// ── Friendly error messages ────────────────────────────────────────────────────
function friendlyError(err) {
  const msg = (err && err.message) || '';
  if (msg.includes('Timed out'))
    return '⏱ 任务超时（10分钟限制），请简化请求后重试。';
  if (msg.includes('No conversation found'))
    return '🔄 会话已过期，已自动重置，请重新发送。';
  if (msg.includes('exited with code'))
    return '⚠️ Claude 处理失败，请稍后重试。如持续出错请发 `new` 重置会话。';
  if (msg.includes('not found') || msg.includes('ENOENT'))
    return '⚠️ 找不到 Claude 引擎，请联系管理员检查服务配置。';
  return '❌ 出了点问题，请稍后重试，或发 `new` 开始新会话。';
}

// ── Main message handler ──────────────────────────────────────────────────────
async function handleMessage(data) {
  try {
    const msg   = data.message;
    const msgId = msg?.message_id;

    // Deduplication: skip already-processed message IDs
    if (msgId) {
      if (processedMsgIds.has(msgId)) {
        logger.log('[msg] duplicate, skip', { msgId });
        return;
      }
      processedMsgIds.add(msgId);
      if (processedMsgIds.size > MAX_PROCESSED_IDS) {
        processedMsgIds.delete(processedMsgIds.values().next().value);
      }
      saveDedup();
    }

    // Filter messages older than MSG_AGE_LIMIT_MS (prevents WS reconnect replays)
    const msgTime   = Number(msg?.create_time);
    const msgTimeMs = msgTime > 1e12 ? msgTime : msgTime > 0 ? msgTime * 1000 : 0;
    const age       = msgTimeMs ? Date.now() - msgTimeMs : 0;
    if (msgTimeMs && age > MSG_AGE_LIMIT_MS) {
      logger.log('[msg] skipping old message', { age: Math.round(age / 1000), msgId });
      return;
    }

    const openId = data.sender?.sender_id?.open_id;
    const chatId = msg?.chat_id;
    logger.log('[msg]', { chatId, openId, type: msg?.message_type, msgId, age: Math.round(age / 1000) + 's' });

    if (!chatId || !openId) return;

    const state = getState(openId);

    // Parse message content (text, image, post, etc.)
    const parsed = await parseMessageContent(msg, chatId, state);
    if (!parsed) return; // handled internally (unsupported type, parse error)
    let { text, tmpFiles } = parsed;

    // Schedule temp file cleanup
    if (tmpFiles.length > 0) {
      setTimeout(() => {
        tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch (_) {} });
      }, TMP_FILE_CLEANUP_MS);
    }

    // Annotate thread replies to help Claude understand context
    if (msg.thread_id && msg.parent_id) {
      text = `[话题回复 thread_id=${msg.thread_id}]\n${text}`;
    }

    logger.log('[claude] prompt preview', { preview: text.slice(0, 120).replace(/\n/g, '↵') });

    // Reject overly long inputs
    if (text.length > MAX_INPUT_LENGTH) {
      await reply(chatId, `⚠️ 消息过长（${text.length} 字符，限制 ${MAX_INPUT_LENGTH}），请分段发送。`);
      return;
    }

    // Check built-in commands first
    if (await handleBuiltinCommand(text, chatId, state)) return;

    // ── Rate limit check ──────────────────────────────────────────────────────
    if (!checkRateLimit(openId)) {
      await reply(chatId, '⚠️ 请求过于频繁，请稍后再试。');
      return;
    }

    // ── Block concurrent runs (set running BEFORE any await to prevent TOCTOU race) ──
    if (state.running) {
      await reply(chatId, '⏳ Still running previous task — send `cancel` to stop it.');
      return;
    }
    state.running = true; // must be set before first await

    const LARK_FORMAT_HINT = `[系统提示：你的回复将展示在 Lark 消息中，请遵守以下格式规则：
- 不要使用 # 标题语法，改用 emoji + **加粗** 作为章节标题（如 🔍 **问题分析**）
- 代码块正常使用 \`\`\`lang，Lark 支持
- 列表、加粗、斜体、链接正常使用
- 不要输出过长的纯文字段落，适当分段
以下是用户的请求：]\n`;

    const startTime  = Date.now();
    const reactionId = await addReaction(msgId);

    // Send placeholder; update it in-place every STREAM_TIMER_MS
    const streamMsgId = await reply(chatId, '⏳ _Thinking…_');
    logger.log('[stream] placeholder msgId', { msgId: streamMsgId });
    state.pendingMsgId = streamMsgId;
    saveState();

    // Timer-driven streaming preview.
    // delivered=true must be set BEFORE clearInterval to block any in-flight tick.
    let latestStreamText  = '';
    let delivered         = false;
    let timerFailCount    = 0;
    let timerPatchPromise = Promise.resolve();
    const onProgress = (currentText) => { latestStreamText = currentText; };

    const thinkingTimer = streamMsgId ? setInterval(() => {
      if (delivered) { clearInterval(thinkingTimer); return; }
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const preview = latestStreamText
        ? (latestStreamText.length > STREAM_PREVIEW_CHARS
            ? latestStreamText.slice(0, STREAM_PREVIEW_CHARS) + '\n\n_…（内容较长，请稍候）_'
            : latestStreamText + '\n\n_…_')
        : `⏳ _Thinking… (${elapsed}s)_`;
      timerPatchPromise = patchMsg(streamMsgId, preview);
      timerPatchPromise.then(ok => {
        if (ok) { timerFailCount = 0; }
        else if (++timerFailCount >= TIMER_FAIL_THRESHOLD) {
          logger.warn('[stream] timer: consecutive patch failures, stopping', { threshold: TIMER_FAIL_THRESHOLD });
          clearInterval(thinkingTimer);
        }
      }).catch(e => {
        logger.warn('[stream] timer patch failed', { msg: e?.message || e });
        if (++timerFailCount >= TIMER_FAIL_THRESHOLD) clearInterval(thinkingTimer);
      });
    }, STREAM_TIMER_MS) : null;

    const run = async (sessionId) => {
      const { result, sessionId: newSessionId } = await runClaude(
        LARK_FORMAT_HINT + text,
        state.workdir,
        sessionId,
        onProgress,
        (proc) => { state.claudeProc = proc; },
      );
      if (newSessionId && newSessionId !== state.sessionId) {
        state.sessionId = newSessionId;
        logger.log(`[${openId}] Session updated`, { from: sessionId || 'new', to: newSessionId });
      }
      return result;
    };

    try {
      const result = await run(state.sessionId);
      saveState();
      delivered = true;
      clearInterval(thinkingTimer);
      await timerPatchPromise;
      await removeReaction(msgId, reactionId);
      await deliverResult(chatId, streamMsgId, result);
    } catch (err) {
      if (state.sessionId && err.message.includes('No conversation found')) {
        logger.log(`[${openId}] Session expired, retrying fresh`);
        state.sessionId = null;
        try {
          const result = await run(null);
          saveState();
          delivered = true;
          clearInterval(thinkingTimer);
          await timerPatchPromise;
          await removeReaction(msgId, reactionId);
          await deliverResult(chatId, streamMsgId, result);
        } catch (err2) {
          delivered = true;
          clearInterval(thinkingTimer);
          await timerPatchPromise;
          await removeReaction(msgId, reactionId);
          logger.error('[claude] error', { msg: err2.message });
          await deliverResult(chatId, streamMsgId, friendlyError(err2));
        }
      } else {
        delivered = true;
        clearInterval(thinkingTimer);
        await timerPatchPromise;
        await removeReaction(msgId, reactionId);
        logger.error('[claude] error', { msg: err.message });
        await deliverResult(chatId, streamMsgId, friendlyError(err));
      }
    } finally {
      clearInterval(thinkingTimer);
      state.running      = false;
      state.claudeProc   = null;
      state.pendingMsgId = null;
      saveState();
    }
  } catch (fatalErr) {
    logger.error('[handleMessage FATAL]', { msg: fatalErr.message, stack: fatalErr.stack });
  }
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function onShutdown(signal) {
  logger.log(`[shutdown] ${signal} received, cleaning up`);
  for (const [, state] of userState.entries()) {
    if (state.claudeProc) {
      try { state.claudeProc.kill('SIGTERM'); } catch (_) {}
    }
  }
  process.exit(0);
}
process.on('SIGTERM', () => onShutdown('SIGTERM'));
process.on('SIGINT',  () => onShutdown('SIGINT'));

// ── Start WebSocket long connection ───────────────────────────────────────────
const wsClient = new lark.WSClient({
  appId:       APP_ID,
  appSecret:   APP_SECRET,
  domain:      lark.Domain.Lark,
  loggerLevel: lark.LoggerLevel.warn,
});

if (process.env.DISABLE_AUTO_REPLY === 'true') {
  logger.log('[bot] DISABLE_AUTO_REPLY=true — running in send-only mode, WS listener not started');
} else {
  wsClient.start({
    eventDispatcher: new lark.EventDispatcher({}).register({
      'im.message.receive_v1': handleMessage,
    }),
  });
}

logger.log('Lark Claude Bot started', {
  node:    NVM_NODE,
  claude:  CLAUDE_CLI || 'NOT FOUND',
  workdir: process.env.WORKDIR || '/Users/kan.lu/Documents/GitHub',
});
