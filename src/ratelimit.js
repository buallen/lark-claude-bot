'use strict';

const { RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } = require('./constants');

// In-memory per-user sliding window rate limiter.
// Stores an array of request timestamps per openId.
const _windows = new Map();

/**
 * Check whether the given user is within the allowed rate limit.
 * @param {string} openId — Lark user open_id
 * @returns {boolean} true = allowed, false = rate-limited
 */
function checkRateLimit(openId) {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;

  let timestamps = _windows.get(openId);
  if (!timestamps) {
    timestamps = [];
    _windows.set(openId, timestamps);
  }

  // Evict timestamps older than the window
  while (timestamps.length > 0 && timestamps[0] < cutoff) {
    timestamps.shift();
  }

  if (timestamps.length >= RATE_LIMIT_MAX) {
    return false; // over limit
  }

  timestamps.push(now);
  return true; // allowed
}

module.exports = { checkRateLimit };
