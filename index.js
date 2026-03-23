'use strict';

// Load .env if present
const path = require('path');
const fs = require('fs');
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  });
}

const lark = require('@larksuiteoapi/node-sdk');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// ── Config ────────────────────────────────────────────────────────────────────
const APP_ID = process.env.LARK_APP_ID;
const APP_SECRET = process.env.LARK_APP_SECRET;
const DEFAULT_WORKDIR = process.env.WORKDIR || '/Users/kan.lu/Documents/GitHub';

if (!APP_ID || !APP_SECRET) {
  console.error('❌ Missing LARK_APP_ID or LARK_APP_SECRET environment variables.');
  console.error('   Set them in .env or export before running.');
  process.exit(1);
}

// Resolve node + claude cli.js from nvm (works under launchd where nvm not in PATH)
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
const CLAUDE_SESSIONS_BASE = path.join(process.env.HOME, '.claude', 'projects');

// ── Lark clients ─────────────────────────────────────────────────────────────
const apiClient = new lark.Client({
  appId: APP_ID,
  appSecret: APP_SECRET,
  domain: lark.Domain.Lark,
  loggerLevel: lark.LoggerLevel.warn,
});

// ── Per-user state ────────────────────────────────────────────────────────────
// key: open_id, value: { workdir, sessionId, running }
const userState = new Map();

function getState(openId) {
  if (!userState.has(openId)) {
    userState.set(openId, { workdir: DEFAULT_WORKDIR, sessionId: null, running: false });
  }
  return userState.get(openId);
}

// ── Session ID helpers ────────────────────────────────────────────────────────
// Encode workdir to claude's project folder name: /Users/x/foo → -Users-x-foo
function encodeWorkdir(dir) {
  return dir.replace(/\//g, '-');
}

// Find the newest session JSONL in claude's project directory for a given workdir
function findLatestSessionId(workdir) {
  const projectDir = path.join(CLAUDE_SESSIONS_BASE, encodeWorkdir(workdir));
  try {
    const files = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({
        name: f,
        mtime: fs.statSync(path.join(projectDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length > 0) return path.basename(files[0].name, '.jsonl');
  } catch (_) {}
  return null;
}

// ── Lark message helpers ──────────────────────────────────────────────────────
async function reply(chatId, text) {
  const CHUNK = 4000;
  const chunks = [];
  for (let i = 0; i < text.length; i += CHUNK) chunks.push(text.slice(i, i + CHUNK));
  for (const chunk of chunks) {
    await apiClient.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        content: JSON.stringify({ text: chunk }),
        msg_type: 'text',
      },
    });
  }
}

// ── Run Claude ────────────────────────────────────────────────────────────────
function runClaude(prompt, workdir, sessionId) {
  return new Promise((resolve, reject) => {
    if (!CLAUDE_CLI) return reject(new Error('claude cli.js not found'));

    const env = {
      ...process.env,
      PATH: `${NVM_BIN}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
      HOME: process.env.HOME,
      TERM: 'xterm-256color',
      FORCE_COLOR: '0',
    };

    const args = [CLAUDE_CLI, '-p', prompt, '--dangerously-skip-permissions', '--output-format', 'text'];
    if (sessionId) args.push('--resume', sessionId);

    let stdout = '';
    let stderr = '';
    const proc = spawn(NVM_NODE, args, { cwd: workdir, env });

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('Timed out after 10 minutes'));
    }, 10 * 60 * 1000);

    proc.on('close', code => {
      clearTimeout(timer);
      const result = stdout.trim() || stderr.trim();
      if (result) resolve(result);
      else if (code === 0) resolve('✅ Done (no output)');
      else reject(new Error(`Claude exited with code ${code}\n${stderr.trim()}`));
    });

    proc.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

// ── Message handler ───────────────────────────────────────────────────────────
const HELP_TEXT = `🤖 Claude Code Bot

📋 Commands:
  help        — show this help
  pwd         — show current directory & session ID
  cd <path>   — change working directory (resets context)
  new         — clear context, start a fresh conversation

💬 Conversation:
  Any other message → sent to Claude Code as a task
  Context is preserved across messages within a session
  Send "new" to start over with a clean slate

📁 Default directory: ${DEFAULT_WORKDIR}

💡 Examples:
  list all subfolders here
  cd my-project
  analyze security issues in this codebase
  new
  what files did you just change?`;

async function handleMessage(data) {
  const msg = data.message;
  const openId = data.sender?.sender_id?.open_id;
  const chatId = msg?.chat_id;

  if (!chatId || !openId) return;
  if (msg.message_type !== 'text') {
    await reply(chatId, '⚠️ Only text messages are supported.');
    return;
  }

  const text = (() => {
    try { return JSON.parse(msg.content).text.trim(); }
    catch (_) { return ''; }
  })();
  if (!text) return;

  const state = getState(openId);

  // ── Built-in commands ────────────────────────────────────────────────────
  if (text === 'help') { await reply(chatId, HELP_TEXT); return; }

  if (text === 'pwd') {
    await reply(chatId, `📁 Directory: \`${state.workdir}\`\n🔗 Session: \`${state.sessionId || 'none'}\``);
    return;
  }

  if (text === 'new') {
    state.sessionId = null;
    await reply(chatId, '🆕 Started a new conversation. Context has been cleared.');
    return;
  }

  if (text.startsWith('cd ')) {
    const raw = text.slice(3).trim().replace(/^~/, process.env.HOME || '~');
    const newDir = path.resolve(state.workdir, raw);
    if (fs.existsSync(newDir) && fs.statSync(newDir).isDirectory()) {
      state.workdir = newDir;
      state.sessionId = null; // new workdir = new session context
      await reply(chatId, `✅ Working directory: \`${newDir}\`\n(Context reset for new directory)`);
    } else {
      await reply(chatId, `❌ Directory not found: \`${newDir}\``);
    }
    return;
  }

  // ── Block concurrent runs ────────────────────────────────────────────────
  if (state.running) {
    await reply(chatId, '⏳ Still running previous task, please wait…');
    return;
  }

  // ── Forward to Claude ────────────────────────────────────────────────────
  state.running = true;
  const sessionLabel = state.sessionId ? '(continuing session)' : '(new session)';
  await reply(chatId, `🔄 Running in \`${state.workdir}\` ${sessionLabel}…`);

  try {
    const result = await runClaude(text, state.workdir, state.sessionId);

    // After first run, capture session ID so next message can resume it
    if (!state.sessionId) {
      const newId = findLatestSessionId(state.workdir);
      if (newId) {
        state.sessionId = newId;
        console.log(`[${openId}] New session started: ${newId}`);
      }
    }

    await reply(chatId, result);
  } catch (err) {
    // If resume failed (session expired etc), retry as fresh session
    if (state.sessionId && err.message.includes('No conversation found')) {
      console.log(`[${openId}] Session ${state.sessionId} not found, starting fresh`);
      state.sessionId = null;
      try {
        const result = await runClaude(text, state.workdir, null);
        const newId = findLatestSessionId(state.workdir);
        if (newId) state.sessionId = newId;
        await reply(chatId, result);
      } catch (err2) {
        await reply(chatId, `❌ Error: ${err2.message}`);
      }
    } else {
      await reply(chatId, `❌ Error: ${err.message}`);
    }
  } finally {
    state.running = false;
  }
}

// ── Start WebSocket long connection ──────────────────────────────────────────
const wsClient = new lark.WSClient({
  appId: APP_ID,
  appSecret: APP_SECRET,
  domain: lark.Domain.Lark,
  loggerLevel: lark.LoggerLevel.warn,
});

wsClient.start({
  eventDispatcher: new lark.EventDispatcher({}).register({
    'im.message.receive_v1': handleMessage,
  }),
});

console.log('✅ Lark Claude Bot started');
console.log(`   Node:   ${NVM_NODE}`);
console.log(`   Claude: ${CLAUDE_CLI || 'NOT FOUND'}`);
console.log(`   Workdir: ${DEFAULT_WORKDIR}`);
