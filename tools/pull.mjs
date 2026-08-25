// pull.mjs — laptop side. Fetch the encrypted archive, decrypt it, write the cold
// copy into C:\Home\Finance\daytracker\.
//
//   node tools/pull.mjs
//
// READ ONLY. This script never writes to GitHub. The phone is the only writer —
// two writers against one file is how a year of records gets lost to a conflict.
//
// Written in Node rather than PowerShell on purpose: Windows PowerShell 5.1 runs on
// .NET Framework, which has no AesGcm class, so it cannot decrypt this format.
// Node is already required for the tests, so this adds nothing to install.

import { pbkdf2Sync, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { reduce, fmtNis } from '../src/reducer.js';
import { CONFIG } from '../src/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT_DIR = process.env.DT_OUT || 'C:\\Home\\Finance\\daytracker';

// ── config from .env (never committed; matches the alday3a-meta-mcp pattern) ──

function loadEnv() {
  const f = join(ROOT, '.env');
  if (!existsSync(f)) {
    console.error('No .env found at ' + f + '\nCopy .env.example to .env and fill it in.');
    process.exit(1);
  }
  const env = {};
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  for (const k of ['DT_OWNER', 'DT_TOKEN', 'DT_PASSPHRASE']) {
    if (!env[k]) { console.error('Missing ' + k + ' in .env'); process.exit(1); }
  }
  return env;
}

// ── decrypt: mirror of src/crypto.js ─────────────────────────────────────────

function decrypt(envelope, passphrase) {
  if (envelope.v !== 1) throw new Error('Unsupported envelope version ' + envelope.v);
  const salt = Buffer.from(envelope.salt, 'base64');
  const iv = Buffer.from(envelope.iv, 'base64');
  const blob = Buffer.from(envelope.ct, 'base64');

  // WebCrypto appends the 16-byte GCM auth tag to the ciphertext.
  const tag = blob.subarray(blob.length - 16);
  const body = blob.subarray(0, blob.length - 16);

  const key = pbkdf2Sync(passphrase, salt, envelope.iter || 310000, 32, 'sha256');
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  let out;
  try {
    out = Buffer.concat([d.update(body), d.final()]);
  } catch {
    throw new Error('Could not decrypt — wrong passphrase, or the file is corrupt.');
  }
  return JSON.parse(out.toString('utf8'));
}

// ── csv ──────────────────────────────────────────────────────────────────────

const cell = (v) => {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

function toCsv(state) {
  const rows = [['type', 'date', 'portion', 'streams', 'amount_nis', 'method', 'note', 'recorded_at', 'logged_after_days']];
  for (const d of state.days) {
    rows.push(['day', d.date, d.portion, d.streams.join('+'), (d.value_agorot / 100).toFixed(2), '', d.note, d.recorded_at, d.logged_after_days]);
  }
  for (const p of [...state.payments].reverse()) {
    rows.push(['payment', p.date, '', '', (p.amount_agorot / 100).toFixed(2), p.method, p.note, p.recorded_at, '']);
  }
  rows.push([]);
  rows.push(['TOTAL earned', '', '', '', (state.earned_agorot / 100).toFixed(2)]);
  rows.push(['TOTAL received', '', '', '', (state.received_agorot / 100).toFixed(2)]);
  rows.push(['OUTSTANDING', '', '', '', (state.balance_agorot / 100).toFixed(2)]);
  return '\uFEFF' + rows.map((r) => r.map(cell).join(',')).join('\r\n');
}

// ── run ──────────────────────────────────────────────────────────────────────

const env = loadEnv();
const url =
  CONFIG.api + '/repos/' + env.DT_OWNER + '/' + CONFIG.repo + '/contents/' + CONFIG.path +
  '?ref=' + encodeURIComponent(CONFIG.branch);

const res = await fetch(url, {
  headers: {
    Authorization: 'Bearer ' + env.DT_TOKEN,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  },
});

if (res.status === 404) { console.error('No archive at ' + CONFIG.path + ' yet.'); process.exit(1); }
if (!res.ok) { console.error('GitHub returned ' + res.status + ' ' + res.statusText); process.exit(1); }

const meta = await res.json();
const envelope = JSON.parse(Buffer.from(meta.content, 'base64').toString('utf8'));
const doc = decrypt(envelope, env.DT_PASSPHRASE);
const state = reduce(doc);

mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);
writeFileSync(join(OUT_DIR, 'daytracker.json'), JSON.stringify(doc, null, 2), 'utf8');
writeFileSync(join(OUT_DIR, 'daytracker-' + stamp + '.csv'), toCsv(state), 'utf8');

console.log('Pulled ' + doc.events.length + ' events (commit ' + String(meta.sha).slice(0, 8) + ')');
console.log('  days worked : ' + state.days.length);
console.log('  earned      : ' + fmtNis(state.earned_agorot) + ' NIS');
console.log('  received    : ' + fmtNis(state.received_agorot) + ' NIS');
console.log('  outstanding : ' + fmtNis(state.balance_agorot) + ' NIS');
console.log('  written to  : ' + OUT_DIR);
