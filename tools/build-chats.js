#!/usr/bin/env node
/**
 * build-chats.js  --  re-encodes the chat transcripts into facebook.html
 *
 * WHY
 *   facebook.html is handed to participants, so the conversation text must not
 *   sit in the file as plain text (Ctrl+U used to reveal every message and the
 *   fugitive's location). The chats now live in chat-data.json -- the readable
 *   file YOU edit -- and this script scrambles them into the
 *   <script type="text/plain" id="chat-blob"> block, which the page decodes at
 *   runtime.
 *
 * HOW TO EDIT THE CHATS
 *   1. Edit chat-data.json (plain readable JSON).
 *   2. Run:  node tools/build-chats.js
 *   3. Open facebook.html to check nothing broke.
 *
 * SECURITY NOTE (be honest with participants about this)
 *   The scramble is a keyed XOR stream, which stops "view source and read the
 *   answers". It does NOT stop someone who opens DevTools and inspects the live
 *   page -- any browser game can be unwrapped at runtime, because the browser
 *   has to know the text to draw it. Treat it as anti-cheating, not secrecy.
 *
 *   NOTE: the key below must stay in sync with chatKeyStream() in facebook.html.
 *   This script reads the key out of facebook.html so there is one source of
 *   truth -- if you change the key, change it in facebook.html.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'facebook.html');
const DATA_PATH = path.join(ROOT, 'chat-data.json');

const BLOB_OPEN = '<script type="text/plain" id="chat-blob">';
const BLOB_CLOSE = '</script>';
const KEY_RE = /const CHAT_BLOB_KEY\s*=\s*'([^']*)'\s*;/;

// Must stay identical to chatKeyStream() in facebook.html
function keyStream(key, len) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h = (h ^ key.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const out = new Uint8Array(len);
  let s = h || 1;
  for (let i = 0; i < len; i++) {
    s = (s ^ (s << 13)) >>> 0;
    s = (s ^ (s >>> 17)) >>> 0;
    s = (s ^ (s << 5)) >>> 0;
    out[i] = s & 0xff;
  }
  return out;
}

function encode(text, key) {
  const bytes = Buffer.from(text, 'utf8');
  const ks = keyStream(key, bytes.length);
  for (let i = 0; i < bytes.length; i++) bytes[i] ^= ks[i];
  return bytes.toString('base64');
}

function decode(b64, key) {
  const bytes = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
  const ks = keyStream(key, bytes.length);
  for (let i = 0; i < bytes.length; i++) bytes[i] ^= ks[i];
  return bytes.toString('utf8');
}

function fail(msg) {
  console.error('ERROR: ' + msg);
  process.exit(1);
}

// ---------------------------------------------------------------- load inputs
if (!fs.existsSync(DATA_PATH)) fail('chat-data.json not found next to facebook.html');

let chatData;
try {
  chatData = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
} catch (e) {
  fail('chat-data.json is not valid JSON -> ' + e.message);
}

let html = fs.readFileSync(HTML_PATH, 'utf8');

const keyMatch = html.match(KEY_RE);
if (!keyMatch) fail("could not find `const CHAT_BLOB_KEY = '...';` in facebook.html");
const key = keyMatch[1];

const open = html.indexOf(BLOB_OPEN);
const close = html.indexOf(BLOB_CLOSE, open === -1 ? 0 : open);
if (open === -1 || close === -1) fail('could not find the id="chat-blob" <script> block in facebook.html');

// ------------------------------------------------------------------ lint data
const problems = [];
for (const [id, convo] of Object.entries(chatData)) {
  if (!convo || !Array.isArray(convo.messages)) {
    problems.push(`"${id}" has no messages array`);
    continue;
  }
  convo.messages.forEach((m, i) => {
    const where = `${id} message ${i + 1}`;
    if (!m.sender) problems.push(`${where}: missing "sender"`);
    if (!m.text && !m.image) problems.push(`${where}: has neither "text" nor "image"`);
    if (m.text !== undefined && typeof m.text !== 'string') problems.push(`${where}: "text" must be a string`);
  });
}

// Warn if a conversation is not in contactDB (it would never show in Chat (8))
const dbStart = html.indexOf('const contactDB = {');
if (dbStart !== -1) {
  try {
    const brace = html.indexOf('{', dbStart);
    let depth = 0, end = -1, inStr = null;
    for (let i = brace; i < html.length; i++) {
      const c = html[i];
      if (inStr) {
        if (c === '\\') { i++; continue; }
        if (c === inStr) inStr = null;
        continue;
      }
      if (c === "'" || c === '"') { inStr = c; continue; }
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { end = i + 1; break; }
    }
    const contactDB = new Function('return ' + html.slice(brace, end))(); // eslint-disable-line no-new-func
    for (const id of Object.keys(chatData)) {
      if (!contactDB[id]) problems.push(`"${id}" is not in contactDB -- this chat will not appear in the chat list`);
    }
  } catch (_) { /* contactDB moved or unparseable; skip this check */ }
}

if (problems.length) {
  console.error('Problems found in chat-data.json:');
  problems.forEach(p => console.error('  - ' + p));
  if (problems.some(p => p.includes('not in contactDB'))) process.exit(1);
  console.error('');
}

// --------------------------------------------------------------------- encode
const json = JSON.stringify(chatData);
const b64 = encode(json, key);
const wrapped = (b64.match(/.{1,96}/g) || []).join('\n');

const oldBlob = html.slice(open + BLOB_OPEN.length, close);
if (oldBlob.replace(/\s+/g, '')) {
  // The blob is still readable with the current key? Then someone hand-edited it.
  try {
    const live = JSON.parse(decode(oldBlob, key));
    if (JSON.stringify(live) !== json) {
      console.error('WARNING: the existing blob in facebook.html does not match chat-data.json.');
      console.error('         chat-data.json is treated as the source of truth; the blob is being replaced.');
      console.error('');
    }
  } catch (_) { /* unreadable blob: normal, means the key changed */ }
}

html = html.slice(0, open + BLOB_OPEN.length) + '\n' + wrapped + '\n    ' + html.slice(close);
fs.writeFileSync(HTML_PATH, html, 'utf8');

// --------------------------------------------------------------------- verify
const checkStart = fs.readFileSync(HTML_PATH, 'utf8').indexOf(BLOB_OPEN);
const checkEnd = fs.readFileSync(HTML_PATH, 'utf8').indexOf(BLOB_CLOSE, checkStart);
const written = fs.readFileSync(HTML_PATH, 'utf8').slice(checkStart + BLOB_OPEN.length, checkEnd);
if (decode(written, key) !== json) fail('verification failed: the blob written to facebook.html does not decode back to the source');

const convs = Object.keys(chatData);
const msgs = convs.reduce((n, id) => n + (chatData[id].messages ? chatData[id].messages.length : 0), 0);
console.log('OK  ' + convs.length + ' conversations, ' + msgs + ' messages, ' + json.length + ' chars -> ' + b64.length + ' encoded chars');
if (problems.length) console.log('NOTE ' + problems.length + ' non-fatal warning(s) listed above');
