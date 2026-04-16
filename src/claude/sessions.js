'use strict';

const fs   = require('fs');
const path = require('path');

const CLAUDE_SESSIONS_BASE = path.join(process.env.HOME, '.claude', 'projects');

/**
 * Encode a workdir path into the format Claude uses for project directory names.
 * Claude replaces '/' and '.' with '-'.
 * NOTE: Collision risk exists for paths differing only by '/' vs '.' vs '-';
 * do NOT change this encoding — it must match what Claude uses.
 */
function encodeWorkdir(dir) {
  return dir.replace(/[/.]/g, '-');
}

/**
 * List all Claude sessions for a given workdir, sorted by mtime descending.
 * @param {string} workdir
 * @returns {Promise<Array<{sessionId: string, mtime: number, label: string}>>}
 */
async function listSessions(workdir) {
  const projectDir = path.join(CLAUDE_SESSIONS_BASE, encodeWorkdir(workdir));
  try {
    const files      = await fs.promises.readdir(projectDir);
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));

    const BATCH_SIZE = 20;
    const sessions   = [];
    for (let i = 0; i < jsonlFiles.length; i += BATCH_SIZE) {
      const batch        = jsonlFiles.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(batch.map(async (f) => {
        const fullPath = path.join(projectDir, f);
        const stat     = await fs.promises.stat(fullPath);
        const sessionId = path.basename(f, '.jsonl');
        let label = '';
        try {
          const content = await fs.promises.readFile(fullPath, 'utf8');
          const lines   = content.split('\n').filter(l => l.trim());
          for (const line of lines.slice(0, 20)) {
            try {
              const ev = JSON.parse(line);
              if (ev.type === 'summary' && ev.summary) { label = ev.summary; break; }
              if (ev.type === 'user' && ev.message?.content) {
                const c = ev.message.content;
                label = typeof c === 'string' ? c : (c[0]?.text || '');
                break;
              }
            } catch (_) {}
          }
        } catch (_) {}
        label = label.replace(/\n/g, ' ').slice(0, 60) || sessionId.slice(0, 8) + '…';
        return { sessionId, mtime: stat.mtimeMs, label };
      }));
      sessions.push(...batchResults);
    }
    return sessions.sort((a, b) => b.mtime - a.mtime);
  } catch (_) { return []; }
}

module.exports = { encodeWorkdir, listSessions, CLAUDE_SESSIONS_BASE };
