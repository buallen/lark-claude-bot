'use strict';

const { apiClient } = require('./client');
const logger        = require('../logger');

// Add a reaction emoji to a message; returns reaction_id or null
async function addReaction(messageId, emojiType = 'Typing') {
  try {
    const res = await apiClient.im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emojiType } },
    });
    if (res.code === 0) return res.data?.reaction_id || null;
    logger.error('[reaction] add failed', { code: res.code, msg: res.msg });
  } catch (e) {
    logger.error('[reaction] add exception', { msg: e.message });
  }
  return null;
}

// Remove a reaction from a message (best-effort)
async function removeReaction(messageId, reactionId) {
  if (!reactionId) return;
  try {
    await apiClient.im.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    });
  } catch (e) {
    logger.error('[reaction] remove exception', { msg: e.message });
  }
}

module.exports = { addReaction, removeReaction };
