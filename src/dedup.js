'use strict';

const fs   = require('fs');
const path = require('path');

const { MAX_PROCESSED_IDS } = require('./constants');
const logger = require('./logger');

const DEDUP_FILE = path.join(__dirname, '..', '.dedup.json');

// In-memory set of processed message IDs (persisted to disk across restarts)
const processedMsgIds = new Set();

function loadDedup() {
  try {
    const ids = JSON.parse(fs.readFileSync(DEDUP_FILE, 'utf8'));
    if (Array.isArray(ids)) ids.forEach(id => processedMsgIds.add(id));
  } catch (_) {}
}

// Async write — does not block the event loop
function saveDedup() {
  const arr = [...processedMsgIds].slice(-MAX_PROCESSED_IDS);
  fs.promises.writeFile(DEDUP_FILE, JSON.stringify(arr)).catch(() => {});
}

module.exports = { processedMsgIds, loadDedup, saveDedup };
