// pull.mjs — laptop side. Fetch the encrypted archive, decrypt it, write the cold
// copy into C:\Home\Finance\daytracker\.
//
//   node tools/pull.mjs
//
// Needs no setup. The GitHub token comes from the gh CLI you are already logged into,
// and the passphrase is asked for at the prompt and never written anywhere. A .env
// can override both if you want it unattended.
//
// READ ONLY. This script never writes to GitHub. The phone is the only writer —
// two writers against one file is how a year of records gets lost to a conflict.
//
// Written in Node rather than PowerShell on purpose: Windows PowerShell 5.1 runs on
// .NET Framework, which has no AesGcm class, so it cannot decrypt this format.
// Node is already required for the tests, so this adds nothing to install.

import { pbkdf2Sync, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

import { reduce, fmtNis } from '../src/reducer.js';
import { CONFIG } from '../src/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT_DIR = process.env.DT_OUT || 'C:\\Home\\Finance\\daytracker';

// ── config ───────────────────────────────────────────────────────────────────

function readEnvFile() {
  const f = join(ROOT, '.env');
  const env = {};
  if (!existsSync(f)) return env;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

/** Reuse the gh CLI's existing login so there is nothing extra to set up. */
function tokenFromGh() {
  try {
    return execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/** Ask for the passphrase without echoing it, and without storing it anywhere. */
function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let shown = false;
    rl._writeToOutput = () => {
      if (!shown) {
        shown = true;
        process.stdout.write(prompt);
      }
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function resolveConfig() {
  const env = readEnvFile();
  const owner = env.DT_OWNER || CONFIG.owner;
  const token = env.DT_TOKEN && !env.DT_TOKEN.includes('xxxx') ? env.DT_TOKEN : tokenFromGh();

  if (!token) {
    console.error('No token. Either run: gh auth login    or put DT_TOKEN in .env');
    process.exit(1);
  }

  // .env, then the environment, then ask. The environment case exists so this can
  // run from a script or a scheduled task without a passphrase sitting in a file.
  let passphrase = env.DT_PASSPHRASE || process.env.DT_PASSPHRASE;
  if (!passphrase) {
    if (!process.stdin.isTTY) {
      console.error('No DT_PASSPHRASE in .env, and no terminal available to ask on.');
      process.exit(1);
    }
    passphrase = await askHidden('Passphrase (the one you set on the phone): ');
  }
  if (!passphrase) {
    console.error('No passphrase given.');
    process.exit(1);
  }

  return { owner, token, passphrase };
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
  for (const c of state.retainerCharges || []) {
    rows.push(['retainer', c.month + '-01', '', '', (c.amount_agorot / 100).toFixed(2), '', 'monthly retainer ' + c.month, '', '']);
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

const { owner, token, passphrase } = await resolveConfig();

const url =
  CONFIG.api + '/repos/' + owner + '/' + CONFIG.repo + '/contents/' + CONFIG.path +
  '?ref=' + encodeURIComponent(CONFIG.branch);

const res = await fetch(url, {
  headers: {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  },
});

if (res.status === 404) {
  console.error('No archive at ' + CONFIG.path + ' yet. Sync from the phone first.');
  process.exit(1);
}
if (!res.ok) {
  console.error('GitHub returned ' + res.status + ' ' + res.statusText);
  process.exit(1);
}

const meta = await res.json();
const envelope = JSON.parse(Buffer.from(meta.content, 'base64').toString('utf8'));

let doc;
try {
  doc = decrypt(envelope, passphrase);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const state = reduce(doc);

mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);
writeFileSync(join(OUT_DIR, 'daytracker.json'), JSON.stringify(doc, null, 2), 'utf8');
writeFileSync(join(OUT_DIR, 'daytracker-' + stamp + '.csv'), toCsv(state), 'utf8');

console.log('');
console.log('Backup opened and copied.  (commit ' + String(meta.sha).slice(0, 8) + ')');
console.log('  entries     : ' + doc.events.length);
console.log('  days worked : ' + state.days.length);
console.log('  earned      : ' + fmtNis(state.earned_agorot) + ' NIS');
console.log('  received    : ' + fmtNis(state.received_agorot) + ' NIS');
console.log('  outstanding : ' + fmtNis(state.balance_agorot) + ' NIS');
console.log('  saved to    : ' + OUT_DIR);
console.log('');
