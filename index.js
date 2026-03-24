'use strict';

const lark = require('@larksuiteoapi/node-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const https = require('https');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

// Load .env if present
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  });
}

// ── Config ────────────────────────────────────────────────────────────────────
const APP_ID = process.env.LARK_APP_ID;
const APP_SECRET = process.env.LARK_APP_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DEFAULT_WORKDIR = process.env.WORKDIR || '/Users/kan.lu/Documents/GitHub';
const STATE_FILE = path.join(__dirname, '.state.json');
const MAX_HISTORY_MESSAGES = 40;

if (!APP_ID || !APP_SECRET) {
  console.error('❌ Missing LARK_APP_ID or LARK_APP_SECRET');
  process.exit(1);
}
if (!ANTHROPIC_API_KEY) {
  console.error('❌ Missing ANTHROPIC_API_KEY');
  process.exit(1);
}

// ── Anthropic client ──────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'Bash',
    description: 'Execute a bash shell command.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to execute' },
        timeout: { type: 'number', description: 'Timeout ms (default 30000, max 120000)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'Read',
    description: 'Read the contents of a file.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        offset: { type: 'number', description: 'Start line (1-indexed)' },
        limit: { type: 'number', description: 'Max lines to read' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'Write',
    description: 'Write content to a file (creates or overwrites).',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'Edit',
    description: 'Replace an exact string in a file with a new string.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'Glob',
    description: 'Find files matching a glob pattern.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern e.g. "**/*.js"' },
        path: { type: 'string', description: 'Directory to search (defaults to workdir)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Grep',
    description: 'Search for a regex pattern in files.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
        glob: { type: 'string', description: 'File filter e.g. "*.js"' },
        output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] },
      },
      required: ['pattern'],
    },
  },
];

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Claude Code, an expert AI coding assistant. You help with software engineering tasks including writing code, debugging, refactoring, and analyzing codebases.

You have access to tools: Bash, Read, Write, Edit, Glob, Grep.

Guidelines:
- Be thorough but efficient — explore before making changes
- Always read files before editing them
- Prefer Edit over Write for existing files
- Run tests after code changes when available
- Provide clear, concise explanations`;

// ── Tool executor ─────────────────────────────────────────────────────────────
async function executeTool(name, input, workdir) {
  try {
    switch (name) {
      case 'Bash': {
        const timeout = Math.min(input.timeout || 30000, 120000);
        return await new Promise((resolve) => {
          exec(input.command, {
            cwd: workdir,
            timeout,
            env: { ...process.env },
            maxBuffer: 10 * 1024 * 1024,
          }, (err, stdout, stderr) => {
            const out = stdout || '';
            const err2 = stderr || '';
            if (err && !out) {
              resolve(`Error (exit ${err.code}): ${err2 || err.message}`);
            } else {
              resolve((out + (err2 ? `\nstderr: ${err2}` : '')).slice(0, 50000));
            }
          });
        });
      }

      case 'Read': {
        const fp = path.resolve(workdir, input.file_path);
        if (!fs.existsSync(fp)) return `Error: File not found: ${fp}`;
        let lines = fs.readFileSync(fp, 'utf8').split('\n');
        const off = input.offset ? input.offset - 1 : 0;
        const lim = input.limit || 2000;
        lines = lines.slice(off, off + lim);
        return lines.map((l, i) => `${off + i + 1}\t${l}`).join('\n');
      }

      case 'Write': {
        const fp = path.resolve(workdir, input.file_path);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, input.content, 'utf8');
        return `Written ${input.content.length} bytes to ${fp}`;
      }

      case 'Edit': {
        const fp = path.resolve(workdir, input.file_path);
        if (!fs.existsSync(fp)) return `Error: File not found: ${fp}`;
        const content = fs.readFileSync(fp, 'utf8');
        if (!content.includes(input.old_string)) {
          return `Error: old_string not found in ${fp}`;
        }
        fs.writeFileSync(fp, content.replace(input.old_string, input.new_string), 'utf8');
        return `Successfully edited ${fp}`;
      }

      case 'Glob': {
        const dir = input.path ? path.resolve(workdir, input.path) : workdir;
        return await new Promise((resolve) => {
          exec(
            `cd "${dir}" && find . -path "./${input.pattern}" -type f 2>/dev/null | head -200`,
            { timeout: 10000 },
            (err, stdout) => resolve(stdout.trim() || '(no matches)')
          );
        });
      }

      case 'Grep': {
        const sp = input.path ? path.resolve(workdir, input.path) : workdir;
        const mode = input.output_mode || 'files_with_matches';
        const flags = mode === 'content' ? '' : mode === 'count' ? '-c' : '-l';
        const glob = input.glob ? `--include="${input.glob}"` : '';
        return await new Promise((resolve) => {
          exec(
            `grep -r ${flags} ${glob} -E "${input.pattern.replace(/"/g, '\\"')}" "${sp}" 2>/dev/null | head -500`,
            { cwd: workdir, timeout: 15000 },
            (err, stdout) => resolve(stdout.trim() || '(no matches)')
          );
        });
      }

      default:
        return `Error: Unknown tool: ${name}`;
    }
  } catch (e) {
    return `Error executing ${name}: ${e.message}`;
  }
}

// ── Lark tenant token (for image download) ────────────────────────────────────
let _tenantToken = null;
let _tenantTokenExp = 0;

async function getTenantToken() {
  if (_tenantToken && Date.now() < _tenantTokenExp) return _tenantToken;
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET });
    const req = https.request(
      {
        hostname: 'open.larksuite.com',
        path: '/open-apis/auth/v3/tenant_access_token/internal',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const j = JSON.parse(data);
            _tenantToken = j.tenant_access_token;
            _tenantTokenExp = Date.now() + (j.expire - 300) * 1000;
            resolve(_tenantToken);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Download image from Lark, returns { data: base64string, mediaType }
async function downloadLarkImage(messageId, imageKey) {
  const token = await getTenantToken();
  return new Promise((resolve, reject) => {
    https
      .get(
        {
          hostname: 'open.larksuite.com',
          path: `/open-apis/im/v1/messages/${messageId}/resources/${imageKey}?type=image`,
          headers: { Authorization: `Bearer ${token}` },
        },
        (res) => {
          if (res.statusCode !== 200) {
            return reject(new Error(`Lark image HTTP ${res.statusCode}`));
          }
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            const ct = (res.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
            const mediaType = ct.includes('png')
              ? 'image/png'
              : ct.includes('gif')
              ? 'image/gif'
              : ct.includes('webp')
              ? 'image/webp'
              : 'image/jpeg';
            resolve({ data: buf.toString('base64'), mediaType });
          });
        }
      )
      .on('error', reject);
  });
}

// ── Lark client ───────────────────────────────────────────────────────────────
const apiClient = new lark.Client({
  appId: APP_ID,
  appSecret: APP_SECRET,
  domain: lark.Domain.Lark,
  loggerLevel: lark.LoggerLevel.warn,
});

// ── Message deduplication ─────────────────────────────────────────────────────
const processedMsgIds = new Set();
const MAX_PROCESSED_IDS = 1000;

// ── Per-user state ────────────────────────────────────────────────────────────
const userState = new Map();

function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(data)) {
      userState.set(k, { workdir: v.workdir || DEFAULT_WORKDIR, messages: [], running: false });
    }
    console.log('[state] loaded', userState.size, 'users');
  } catch (_) {}
}

function saveState() {
  try {
    const data = {};
    for (const [k, v] of userState.entries()) data[k] = { workdir: v.workdir };
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[state] save error:', e.message);
  }
}

function getState(openId) {
  if (!userState.has(openId)) {
    userState.set(openId, { workdir: DEFAULT_WORKDIR, messages: [], running: false });
  }
  return userState.get(openId);
}

loadState();

// ── Lark reply helper ─────────────────────────────────────────────────────────
async function reply(chatId, text) {
  const CHUNK = 4000;
  for (let i = 0; i < text.length; i += CHUNK) {
    try {
      const res = await apiClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ text: text.slice(i, i + CHUNK) }),
          msg_type: 'text',
        },
      });
      if (res.code !== 0) console.error('[reply error]', res.code, res.msg);
    } catch (e) {
      console.error('[reply exception]', e.message);
    }
  }
}

// ── Tool label formatter ──────────────────────────────────────────────────────
function fmtTool(name, input = {}) {
  if (name === 'Bash') return `\`${(input.command || '').slice(0, 60)}\``;
  if (name === 'Read') return `Read \`${input.file_path || ''}\``;
  if (name === 'Write') return `Write \`${input.file_path || ''}\``;
  if (name === 'Edit') return `Edit \`${input.file_path || ''}\``;
  if (name === 'Grep') return `Grep \`${input.pattern || ''}\``;
  if (name === 'Glob') return `Glob \`${input.pattern || ''}\``;
  return name;
}

// ── Run Claude via SDK ────────────────────────────────────────────────────────
// userContent: string | Array (Anthropic multimodal content array)
async function runClaude(userContent, state, onToolUse) {
  state.messages.push({ role: 'user', content: userContent });

  if (state.messages.length > MAX_HISTORY_MESSAGES) {
    state.messages = state.messages.slice(-MAX_HISTORY_MESSAGES);
  }

  let toolCallCount = 0;
  let lastNotify = 0;

  while (true) {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: state.messages,
    });

    state.messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      const text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return text || '✅ Done (no output)';
    }

    if (response.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        toolCallCount++;
        const now = Date.now();
        if (now - lastNotify >= 15_000) {
          lastNotify = now;
          onToolUse(`🔧 ${fmtTool(block.name, block.input)} (tool #${toolCallCount})`);
        }
        if (process.env.DEBUG) {
          console.log(`[tool] ${block.name}`, JSON.stringify(block.input).slice(0, 200));
        }

        const result = await executeTool(block.name, block.input, state.workdir);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        });
      }
      state.messages.push({ role: 'user', content: toolResults });
      continue;
    }

    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return text || `⚠️ Stopped (reason: ${response.stop_reason})`;
  }
}

// ── Help text ─────────────────────────────────────────────────────────────────
const HELP_TEXT = `🤖 Claude Code Bot (SDK mode)

📋 Commands:
  help        — show this help
  pwd         — show current directory
  cd <path>   — change working directory (resets conversation)
  new         — clear context, start fresh

💬 Usage:
  Send text, images, or rich-text (post) messages
  Context is preserved across messages
  Send "new" to start over

📁 Default directory: ${DEFAULT_WORKDIR}`;

// ── Message handler ───────────────────────────────────────────────────────────
async function handleMessage(data) {
  try {
    const msg = data.message;
    const msgId = msg?.message_id;

    // Deduplication
    if (msgId) {
      if (processedMsgIds.has(msgId)) {
        console.log('[msg] duplicate, skip:', msgId);
        return;
      }
      processedMsgIds.add(msgId);
      if (processedMsgIds.size > MAX_PROCESSED_IDS) {
        processedMsgIds.delete(processedMsgIds.values().next().value);
      }
    }

    // Skip old messages (> 60s)
    const msgTime = Number(msg?.create_time);
    const age = msgTime ? Date.now() - msgTime : 0;
    if (msgTime && age > 60_000) {
      console.log('[msg] old message skip, age:', Math.round(age / 1000) + 's');
      return;
    }

    const openId = data.sender?.sender_id?.open_id;
    const chatId = msg?.chat_id;
    console.log('[msg]', msg?.message_type, 'from', openId, 'msgId:', msgId);

    if (!chatId || !openId) return;

    // ── Parse message into userContent ────────────────────────────────────────
    // userContent: string (text-only) or Array (multimodal: text + images)
    let userContent = null;
    const msgType = msg.message_type;

    if (msgType === 'text') {
      try {
        userContent = JSON.parse(msg.content).text.trim();
      } catch (_) {}
      if (!userContent) return;

    } else if (msgType === 'image') {
      let imageKey;
      try {
        imageKey = JSON.parse(msg.content).image_key;
      } catch (_) {}
      if (!imageKey) {
        await reply(chatId, '⚠️ Could not parse image key.');
        return;
      }
      try {
        const { data: imgData, mediaType } = await downloadLarkImage(msgId, imageKey);
        userContent = [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imgData } },
          { type: 'text', text: 'Please analyze this image.' },
        ];
      } catch (e) {
        await reply(chatId, `❌ Failed to download image: ${e.message}`);
        return;
      }

    } else if (msgType === 'post') {
      // Rich text — may contain text and/or embedded images
      let postContent;
      try {
        postContent = JSON.parse(msg.content);
      } catch (_) {}
      if (!postContent) {
        await reply(chatId, '⚠️ Could not parse post.');
        return;
      }

      const lang = postContent.zh_cn || postContent.en_us || Object.values(postContent)[0];
      if (!lang) {
        await reply(chatId, '⚠️ Empty post.');
        return;
      }

      const parts = [];
      if (lang.title) parts.push({ type: 'text', text: `${lang.title}\n` });

      for (const line of (lang.content || [])) {
        for (const el of line) {
          if (el.tag === 'text' && el.text) {
            parts.push({ type: 'text', text: el.text });
          } else if (el.tag === 'img' && el.image_key) {
            try {
              const { data: imgData, mediaType } = await downloadLarkImage(msgId, el.image_key);
              parts.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: imgData } });
            } catch (e) {
              parts.push({ type: 'text', text: `[image failed: ${e.message}]` });
            }
          }
        }
        parts.push({ type: 'text', text: '\n' });
      }

      if (parts.length === 0) return;
      userContent = parts;

    } else {
      await reply(chatId, `⚠️ Unsupported message type: ${msgType}`);
      return;
    }

    const state = getState(openId);

    // ── Built-in commands (text only) ─────────────────────────────────────────
    const cmd = typeof userContent === 'string' ? userContent : null;

    if (cmd === 'help') {
      await reply(chatId, HELP_TEXT);
      return;
    }

    if (cmd === 'pwd') {
      await reply(chatId, `📁 \`${state.workdir}\`\n💬 History: ${state.messages.length} messages`);
      return;
    }

    if (cmd === 'new') {
      state.messages = [];
      saveState();
      await reply(chatId, '🆕 Conversation cleared.');
      return;
    }

    if (cmd && cmd.startsWith('cd ')) {
      const raw = cmd.slice(3).trim().replace(/^~/, process.env.HOME || '~');
      const newDir = path.resolve(state.workdir, raw);
      if (fs.existsSync(newDir) && fs.statSync(newDir).isDirectory()) {
        state.workdir = newDir;
        state.messages = [];
        saveState();
        await reply(chatId, `✅ Working directory: \`${newDir}\`\n(Conversation reset)`);
      } else {
        await reply(chatId, `❌ Directory not found: \`${newDir}\``);
      }
      return;
    }

    // ── Block concurrent runs ─────────────────────────────────────────────────
    if (state.running) {
      await reply(chatId, '⏳ Still running previous task, please wait…');
      return;
    }

    // ── Forward to Claude ─────────────────────────────────────────────────────
    state.running = true;
    const histLabel = state.messages.length > 0 ? '(continuing)' : '(new conversation)';
    await reply(chatId, `🔄 \`${state.workdir}\` ${histLabel}…`);

    try {
      const result = await runClaude(userContent, state, (toolMsg) => {
        reply(chatId, toolMsg).catch(() => {});
      });
      saveState();
      await reply(chatId, result);
    } catch (err) {
      console.error('[claude error]', err.message);
      await reply(chatId, `❌ Error: ${err.message}`);
    } finally {
      state.running = false;
    }

  } catch (fatalErr) {
    console.error('[handleMessage FATAL]', fatalErr.message, fatalErr.stack);
  }
}

// ── Start WebSocket long connection ───────────────────────────────────────────
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

console.log('✅ Lark Claude Bot started (SDK mode, image support enabled)');
console.log(`   Model:   claude-opus-4-6`);
console.log(`   Workdir: ${DEFAULT_WORKDIR}`);
