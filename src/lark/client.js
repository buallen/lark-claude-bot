'use strict';

const lark  = require('@larksuiteoapi/node-sdk');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const logger = require('../logger');

const APP_ID     = process.env.LARK_APP_ID;
const APP_SECRET = process.env.LARK_APP_SECRET;

// Shared Lark REST API client
const apiClient = new lark.Client({
  appId:       APP_ID,
  appSecret:   APP_SECRET,
  domain:      lark.Domain.Lark,
  loggerLevel: lark.LoggerLevel.warn,
});

// ── Tenant token cache ────────────────────────────────────────────────────────
let _tenantToken    = null;
let _tenantTokenExp = 0;

async function getTenantToken() {
  if (_tenantToken && Date.now() < _tenantTokenExp) return _tenantToken;
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET });
    const req  = https.request({
      hostname: 'open.larksuite.com',
      path:     '/open-apis/auth/v3/tenant_access_token/internal',
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          const j       = JSON.parse(data);
          _tenantToken  = j.tenant_access_token;
          _tenantTokenExp = Date.now() + (j.expire - 300) * 1000;
          resolve(_tenantToken);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Download a Lark image, save to saveDir (or DEFAULT_WORKDIR), return local path
async function downloadLarkImage(messageId, imageKey, saveDir) {
  const { DEFAULT_WORKDIR } = require('../state');
  const token = await getTenantToken();
  return new Promise((resolve, reject) => {
    https.get({
      hostname: 'open.larksuite.com',
      path:     `/open-apis/im/v1/messages/${messageId}/resources/${imageKey}?type=image`,
      headers:  { Authorization: `Bearer ${token}` },
    }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`Lark image HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const ct  = (res.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
        const ext = ct.includes('png') ? 'png' : ct.includes('gif') ? 'gif' : ct.includes('webp') ? 'webp' : 'jpg';
        const dir     = saveDir || DEFAULT_WORKDIR;
        const imgPath = path.join(dir, `lark_img_${Date.now()}.${ext}`);
        fs.writeFileSync(imgPath, buf);
        resolve(imgPath);
      });
    }).on('error', reject);
  });
}

module.exports = { apiClient, getTenantToken, downloadLarkImage };
