'use strict';

const { CARD_ELEMENT_LIMIT, CHUNK_LIMIT } = require('../constants');

/**
 * Preprocess markdown for Lark card rendering.
 * Lark card markdown supports bold/italic/strikethrough/links/lists/code blocks.
 * Does NOT support: # headings, > blockquotes → convert those two only.
 *
 * Known limitation (H-1): If input contains an unclosed ``` fence, all lines
 * after the opening fence are returned verbatim (no heading/blockquote transform).
 * Acceptable for streaming previews — deliverResult always processes the complete text.
 */
function preprocessForLarkMarkdown(md) {
  let inCodeBlock = false;
  return md.split('\n').map(line => {
    if (line.trimStart().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      return line;
    }
    if (inCodeBlock) return line;
    const hm = line.match(/^#{1,3}\s+(.+)/);
    if (hm) return `**${hm[1]}**`;
    const bqm = line.match(/^>+\s*(.*)/);
    if (bqm) return bqm[1] ? `**│** *${bqm[1]}*` : '**│**';
    return line;
  }).join('\n');
}

/**
 * Pack markdown into an interactive card JSON string (schema 2.0).
 * Splits content into multiple markdown elements to respect CARD_ELEMENT_LIMIT.
 */
function makeCardContent(markdownText) {
  const processed = preprocessForLarkMarkdown(markdownText);
  const lines     = processed.split('\n');
  const elements  = [];
  let cur = [], curLen = 0;
  for (const line of lines) {
    if (curLen + line.length + 1 > CARD_ELEMENT_LIMIT && cur.length > 0) {
      elements.push({ tag: 'markdown', content: cur.join('\n') });
      cur = []; curLen = 0;
    }
    cur.push(line);
    curLen += line.length + 1;
  }
  if (cur.length > 0) elements.push({ tag: 'markdown', content: cur.join('\n') });
  return JSON.stringify({ schema: '2.0', config: { wide_screen_mode: true }, body: { elements } });
}

/**
 * Split long text into chunks of at most CHUNK_LIMIT characters,
 * preferring paragraph and line boundaries.
 */
function splitIntoChunks(text) {
  if (text.length <= CHUNK_LIMIT) return [text];
  const chunks     = [];
  const paragraphs = text.split(/\n\n+/);
  let cur = '';
  for (const p of paragraphs) {
    const add = cur ? '\n\n' + p : p;
    if (cur.length + add.length <= CHUNK_LIMIT) {
      cur += add;
    } else {
      if (cur) { chunks.push(cur); cur = ''; }
      const lines = p.split('\n');
      for (const line of lines) {
        const addLine = cur ? '\n' + line : line;
        if (cur.length + addLine.length <= CHUNK_LIMIT) {
          cur += addLine;
        } else {
          if (cur) { chunks.push(cur); cur = ''; }
          if (line.length > CHUNK_LIMIT) {
            for (let i = 0; i < line.length; i += CHUNK_LIMIT) {
              chunks.push(line.slice(i, i + CHUNK_LIMIT));
            }
          } else {
            cur = line;
          }
        }
      }
    }
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : [text];
}

module.exports = { makeCardContent, preprocessForLarkMarkdown, splitIntoChunks, CHUNK_LIMIT };
