'use strict';

const { downloadLarkImage } = require('../lark/client');
const { reply }             = require('../lark/messages');
const logger                = require('../logger');

/**
 * Parse incoming Lark message content into { text, tmpFiles }.
 * Handles: text, image, post (rich text), merge_forward, interactive (card), file, audio, video.
 * Returns null if the message type is unsupported or a parse error occurred
 * (an error reply is sent internally in those cases).
 *
 * @param {object} msg     — Lark message object
 * @param {string} chatId
 * @param {object} state   — user state (provides workdir for image download)
 * @returns {Promise<{text: string, tmpFiles: string[]}|null>}
 */
async function parseMessageContent(msg, chatId, state) {
  const msgType = msg.message_type;
  const tmpFiles = [];

  if (msgType === 'text') {
    let text = '';
    try { text = JSON.parse(msg.content).text.trim(); } catch (_) {}
    if (!text) return null;
    return { text, tmpFiles };

  } else if (msgType === 'image') {
    let imageKey;
    try { imageKey = JSON.parse(msg.content).image_key; } catch (_) {}
    if (!imageKey) { await reply(chatId, '⚠️ 无法解析图片。'); return null; }
    try {
      const imgPath = await downloadLarkImage(msg.message_id, imageKey, state.workdir);
      tmpFiles.push(imgPath);
      return { text: `图片已下载到本地路径：${imgPath}\n请立即调用 Read 工具读取该文件，然后描述图片内容。`, tmpFiles };
    } catch (e) {
      await reply(chatId, `❌ 图片下载失败: ${e.message}`);
      return null;
    }

  } else if (msgType === 'post') {
    let postContent;
    try { postContent = JSON.parse(msg.content); } catch (_) {}
    if (!postContent) { await reply(chatId, '⚠️ 无法解析富文本。'); return null; }
    const lang      = postContent.zh_cn || postContent.en_us || Object.values(postContent)[0];
    const textParts = [];
    if (lang?.title) textParts.push(lang.title);
    for (const line of (lang?.content || [])) {
      for (const el of line) {
        if (el.tag === 'text' && el.text) {
          textParts.push(el.text);
        } else if (el.tag === 'at' && el.user_name) {
          textParts.push(`@${el.user_name}`);
        } else if (el.tag === 'img' && el.image_key) {
          try {
            const imgPath = await downloadLarkImage(msg.message_id, el.image_key, state.workdir);
            tmpFiles.push(imgPath);
            textParts.push(`[图片已下载至 ${imgPath}，请调用 Read 工具读取并描述内容]`);
          } catch (e) {
            textParts.push(`[图片下载失败: ${e.message}]`);
          }
        }
      }
    }
    let text = textParts.join('\n').trim();
    if (!text) {
      logger.log('[msg] post content empty', { raw: msg.content?.slice(0, 300) });
      text = `[富文本消息（原始内容）]\n${msg.content?.slice(0, 1000) || ''}`;
    }
    return { text, tmpFiles };

  } else if (msgType === 'merge_forward') {
    let content;
    try { content = JSON.parse(msg.content); } catch (_) {}
    const msgList = content?.merge_forward_content?.message_list || [];
    if (msgList.length === 0) { await reply(chatId, '⚠️ 无法解析转发记录。'); return null; }
    const lines = [`[转发的聊天记录，共 ${msgList.length} 条]`];
    for (const m of msgList) {
      const from = m.from_name || m.from || '未知';
      const ts   = m.create_time ? new Date(Number(m.create_time) * 1000).toLocaleString('zh-CN') : '';
      let body   = '';
      try {
        const c = JSON.parse(m.message?.content || '{}');
        if (c.text)      body = c.text;
        else if (c.image_key) body = '[图片]';
        else             body = m.message?.content?.slice(0, 200) || '';
      } catch (_) { body = m.message?.content?.slice(0, 200) || ''; }
      lines.push(`${from}${ts ? ` (${ts})` : ''}: ${body}`);
    }
    return { text: lines.join('\n'), tmpFiles };

  } else if (msgType === 'interactive') {
    let card;
    try { card = JSON.parse(msg.content); } catch (_) {}
    const parts = [];
    const title = card?.header?.title?.content || card?.header?.title?.text
      || card?.card?.header?.title?.content || '';
    if (title) parts.push(`标题: ${title}`);
    const extractText = (el) => {
      if (!el || typeof el === 'string') return el || '';
      if (el.content) return el.content;
      if (el.text) return typeof el.text === 'string' ? el.text : (el.text?.content || '');
      if (Array.isArray(el.elements)) return el.elements.map(extractText).filter(Boolean).join(' ');
      if (Array.isArray(el.fields))   return el.fields.map(f => extractText(f.text)).filter(Boolean).join(', ');
      return '';
    };
    const elements = card?.elements || card?.body?.elements || card?.card?.elements || [];
    for (const el of elements) {
      const t = extractText(el).trim();
      if (t) parts.push(t);
    }
    const text = parts.length > 0
      ? `[Lark 卡片消息]\n${parts.join('\n')}`
      : `[Lark 卡片消息（原始 JSON）]\n${JSON.stringify(card).slice(0, 1000)}`;
    return { text, tmpFiles };

  } else if (msgType === 'file' || msgType === 'audio') {
    let info = '';
    try { const c = JSON.parse(msg.content); info = c.file_name || c.file_key || ''; } catch (_) {}
    await reply(chatId, `⚠️ 暂不支持 ${msgType} 消息${info ? `（${info}）` : ''}，请发送文字或图片。`);
    return null;

  } else if (msgType === 'video') {
    await reply(chatId, '⚠️ 暂不支持视频消息，请截图后发送图片。');
    return null;

  } else {
    logger.log('[msg] unknown type', { type: msgType, content: msg.content?.slice(0, 300) });
    await reply(chatId, `⚠️ 暂不支持的消息类型: ${msgType}`);
    return null;
  }
}

module.exports = { parseMessageContent };
