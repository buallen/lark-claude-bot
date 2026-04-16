'use strict';

const fs   = require('fs');
const path = require('path');

const { reply, replyLong }                  = require('../lark/messages');
const { listSessions, encodeWorkdir, CLAUDE_SESSIONS_BASE } = require('../claude/sessions');
const { saveState, DEFAULT_WORKDIR }        = require('../state');
const logger                                = require('../logger');

// ── Help text ─────────────────────────────────────────────────────────────────
const HELP_TEXT = `🤖 Claude Code Bot

📋 Commands:
  help          — 显示帮助
  pwd           — 显示当前目录和会话 ID
  cd <path>     — 切换工作目录（重置上下文）
  new           — 清除上下文，开始新会话
  cancel        — 取消当前正在运行的任务
  sessions      — 列出当前目录的历史会话
  use <n>       — 切换到第 n 个历史会话
  history [n]   — 查看当前会话最近 n 轮对话（默认 5 轮）

💬 对话:
  其他消息 → 直接发送给 Claude Code
  同一会话内保留上下文
  发送 "new" 重新开始

📁 默认目录: ${DEFAULT_WORKDIR}`;

/**
 * Handle built-in bot commands.
 * @returns {Promise<boolean>} true if command was handled (caller should return), false to continue to Claude.
 */
async function handleBuiltinCommand(text, chatId, state) {
  if (text === 'help') {
    await reply(chatId, HELP_TEXT);
    return true;
  }

  if (text === 'test') {
    await reply(chatId, `# 标题 H1
## 标题 H2

普通文本，**加粗**，*斜体*，~~删除线~~，\`内联代码\`

> 这是引用块
> 多行引用

- 无序列表项 1
- 无序列表项 2
  - 嵌套项

1. 有序列表 1
2. 有序列表 2

[点击链接](https://www.google.com)

\`\`\`javascript
const hello = "world";
console.log(hello);
\`\`\`

---

表格（如果支持）:
| 列1 | 列2 |
|-----|-----|
| A   | B   |`);
    return true;
  }

  if (text === 'pwd') {
    await reply(chatId, `📁 Directory: \`${state.workdir}\`\n🔗 Session: \`${state.sessionId || 'none'}\``);
    return true;
  }

  if (text === 'cancel') {
    if (!state.running || !state.claudeProc) {
      await reply(chatId, '⚠️ 当前没有正在运行的任务。');
    } else {
      try { state.claudeProc.kill('SIGTERM'); } catch (_) {}
      await reply(chatId, '🛑 已发送取消信号，正在停止…');
    }
    return true;
  }

  if (/^history(\s+\d+)?$/.test(text)) {
    const n = parseInt(text.split(/\s+/)[1] || '5', 10);
    if (!state.sessionId) { await reply(chatId, '⚠️ 当前没有会话记录。'); return true; }
    const sessionFile = path.join(CLAUDE_SESSIONS_BASE, encodeWorkdir(state.workdir), state.sessionId + '.jsonl');
    try {
      const lines = (await fs.promises.readFile(sessionFile, 'utf8')).split('\n').filter(l => l.trim());
      const turns = [];
      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'user' && ev.message?.content) {
            const c   = ev.message.content;
            const txt = (typeof c === 'string' ? c : c.map(b => b.text || '').join('')).trim();
            if (txt) turns.push({ role: '👤', text: txt.slice(0, 300) });
          } else if (ev.type === 'assistant' && ev.message?.content) {
            const txt = ev.message.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
            if (txt) turns.push({ role: '🤖', text: txt.slice(0, 300) });
          }
        } catch (_) {}
      }
      const recent = turns.slice(-n * 2);
      if (recent.length === 0) { await reply(chatId, '📭 当前会话没有消息记录。'); return true; }
      const out = recent.map(t => `${t.role} ${t.text}`).join('\n\n---\n\n');
      await replyLong(chatId, `📜 **最近 ${Math.ceil(recent.length / 2)} 轮对话**\n\n${out}`);
    } catch (e) {
      await reply(chatId, `❌ 读取历史失败: ${e.message}`);
    }
    return true;
  }

  if (text === 'new') {
    state.sessionId = null;
    saveState();
    await reply(chatId, '🆕 已开始新会话，上下文已清除。');
    return true;
  }

  if (text === 'sessions' || /^sessions \d+$/.test(text)) {
    const PAGE_SIZE   = 10;
    const page        = text === 'sessions' ? 1 : parseInt(text.split(' ')[1], 10);
    const sessions    = await listSessions(state.workdir);
    if (sessions.length === 0) {
      await reply(chatId, `📭 当前目录 \`${state.workdir}\` 没有历史会话。`);
      return true;
    }
    const totalPages = Math.ceil(sessions.length / PAGE_SIZE);
    const p          = Math.max(1, Math.min(page, totalPages));
    const slice      = sessions.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
    const lines      = slice.map((s, i) => {
      const idx  = (p - 1) * PAGE_SIZE + i + 1;
      const date = new Date(s.mtime).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      const active = s.sessionId === state.sessionId ? ' ◀ 当前' : '';
      return `**${idx}.** ${s.label}\n   *${date}*${active}`;
    });
    let header = `📋 **历史会话** (共 ${sessions.length} 个，第 ${p}/${totalPages} 页)\n`;
    if (totalPages > 1) header += `发 \`sessions ${p + 1 <= totalPages ? p + 1 : 1}\` 翻页，发 \`use <序号>\` 切换\n`;
    else                header += `发 \`use <序号>\` 切换\n`;
    await reply(chatId, header + '\n' + lines.join('\n\n'));
    return true;
  }

  if (text.startsWith('use ')) {
    const n        = parseInt(text.slice(4).trim(), 10);
    const sessions = await listSessions(state.workdir);
    if (isNaN(n) || n < 1 || n > sessions.length) {
      await reply(chatId, `❌ 请输入有效序号 1–${sessions.length}，先发 \`sessions\` 查看列表。`);
      return true;
    }
    const target    = sessions[n - 1];
    state.sessionId = target.sessionId;
    saveState();
    await reply(chatId, `✅ 已切换到会话 **${n}**: ${target.label}`);
    return true;
  }

  if (text.startsWith('cd ')) {
    const raw    = text.slice(3).trim().replace(/^~/, process.env.HOME || '~');
    const newDir = path.resolve(state.workdir, raw);
    if (fs.existsSync(newDir) && fs.statSync(newDir).isDirectory()) {
      state.workdir  = newDir;
      state.sessionId = null;
      saveState();
      await reply(chatId, `✅ Working directory: \`${newDir}\`\n(Context reset for new directory)`);
    } else {
      await reply(chatId, `❌ Directory not found: \`${newDir}\``);
    }
    return true;
  }

  return false; // not a built-in command
}

module.exports = { handleBuiltinCommand, HELP_TEXT };
