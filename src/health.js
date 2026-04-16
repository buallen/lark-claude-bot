'use strict';

const http = require('http');

const { HEALTH_PORT } = require('./constants');
const logger = require('./logger');
const { send } = require('./lark/messages');

const _startTime = Date.now();

/**
 * Start a lightweight HTTP health-check server.
 * GET /health → 200 JSON: { status, uptime, pid, users, version }
 * Startup failures only emit a warning and do NOT crash the main process.
 */
function startHealthServer() {
  // Lazy-require userState to avoid circular dependency at module load time
  const { userState } = require('./state');

  let pkg = { version: 'unknown' };
  try { pkg = require('../package.json'); } catch (_) {}

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      const body = JSON.stringify({
        status:  'ok',
        uptime:  Math.floor((Date.now() - _startTime) / 1000),
        pid:     process.pid,
        users:   userState.size,
        version: pkg.version || 'unknown',
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);

    } else if (req.method === 'POST' && req.url === '/send') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const { receive_id, receive_id_type = 'chat_id', text } = JSON.parse(body);
          if (!receive_id || !text) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: 'receive_id and text are required' }));
          }
          const messageId = await send(receive_id, text, receive_id_type);
          res.writeHead(messageId ? 200 : 502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(messageId ? { ok: true, message_id: messageId } : { ok: false, error: 'send failed' }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });

    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  server.on('error', (err) => {
    logger.warn('[health] server error, health checks disabled', { msg: err.message });
  });

  server.listen(HEALTH_PORT, '0.0.0.0', () => {
    logger.log('[health] server listening', { port: HEALTH_PORT });
  });

  return server;
}

module.exports = { startHealthServer };
