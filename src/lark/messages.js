'use strict';

const { apiClient }               = require('./client');
const { makeCardContent, splitIntoChunks } = require('./card');
const logger                      = require('../logger');

// Send a new interactive card; returns message_id or null
async function reply(chatId, markdown) {
  try {
    const res = await apiClient.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        content:    makeCardContent(markdown),
        msg_type:   'interactive',
      },
    });
    if (res.code !== 0) {
      logger.error('[reply error]', { code: res.code, msg: res.msg, body: JSON.stringify(res).slice(0, 300) });
      return null;
    }
    return res.data?.message_id || null;
  } catch (e) {
    logger.error('[reply exception]', { msg: e.message, body: e.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : '' });
    return null;
  }
}

// Send a long response, splitting into multiple cards if needed; returns last message_id
async function replyLong(chatId, markdown) {
  const chunks = splitIntoChunks(markdown);
  let lastId = null;
  for (let i = 0; i < chunks.length; i++) {
    const label = chunks.length > 1 ? `*(${i + 1}/${chunks.length})*\n\n` : '';
    lastId = await reply(chatId, label + chunks[i]);
  }
  return lastId;
}

// Edit an interactive card in-place; returns true on success
async function patchMsg(messageId, markdown) {
  if (!messageId) return false;
  try {
    const content = makeCardContent(markdown);
    const res     = await apiClient.im.message.patch({
      path: { message_id: messageId },
      data: { content },
    });
    if (res.code !== 0) {
      logger.error('[patch error]', { code: res.code, msg: res.msg });
      return false;
    }
    return true;
  } catch (e) {
    const body = e.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : '(no body)';
    logger.error('[patch exception]', { msg: e.message || '(empty)', status: e.response?.status ?? 'none', body });
    return false;
  }
}

// Delete a message (best-effort)
async function deleteMsg(messageId) {
  try { await apiClient.im.message.delete({ path: { message_id: messageId } }); } catch (_) {}
}

// Deliver final result: patch placeholder or fallback to new reply
async function deliverResult(chatId, streamMsgId, text) {
  if (!text) return;
  const chunks = splitIntoChunks(text);
  for (let i = 0; i < chunks.length; i++) {
    const label   = chunks.length > 1 ? `*(${i + 1}/${chunks.length})*\n\n` : '';
    const content = label + chunks[i];
    if (i === 0 && streamMsgId) {
      const ok = await patchMsg(streamMsgId, content);
      if (ok) {
        logger.log('[deliver] patch ok', { msgId: streamMsgId, len: content.length });
      } else {
        logger.warn('[deliver] patch failed, fallback reply', { msgId: streamMsgId });
        if (streamMsgId) await deleteMsg(streamMsgId);
        await reply(chatId, content);
      }
    } else {
      await reply(chatId, content);
    }
  }
}

// Send a message to any receive_id (chat_id, open_id, user_id, etc.)
async function send(receiveId, markdown, receiveIdType = 'chat_id') {
  try {
    const res = await apiClient.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        content:    makeCardContent(markdown),
        msg_type:   'interactive',
      },
    });
    if (res.code !== 0) {
      logger.error('[send error]', { code: res.code, msg: res.msg });
      return null;
    }
    return res.data?.message_id || null;
  } catch (e) {
    logger.error('[send exception]', { msg: e.message });
    return null;
  }
}

module.exports = { reply, replyLong, patchMsg, deleteMsg, deliverResult, send };
