// rekey.mjs — change the passphrase that protects the archive.
//
//   node tools/rekey.mjs
//
// Decrypts with the old passphrase, re-encrypts with the new one, pushes one commit.
// The events themselves are untouched — only the lock on the door changes.
//
// AFTERWARDS you must set the new passphrase on the phone (Setup -> Passphrase),
// or its next sync will fail to read the archive. It will fail LOUDLY and refuse to
// overwrite, so nothing is destroyed either way — but sync stops until you do it.
//
// Older commits stay readable with the OLD passphrase. Rotation protects what happens
// from now on; it cannot un-publish history. If the old passphrase leaked, treat every
// commit before this one as readable by whoever has it.

import { pbkdf2Sync, createDecipheriv, webcrypto } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

import { reduce, fmtNis, SCHEMA_VERSION } from '../src/reducer.js';
import { CONFIG } from '../src/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

function tokenFromGh() {
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function ask(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let shown = false;
    rl._writeToOutput = () => { if (!shown) { shown = true; process.stdout.write(prompt); } };
    rl.question(prompt, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

async function main() {
const OWNER = process.env.DT_OWNER || CONFIG.owner;
const TOKEN = process.env.DT_TOKEN || tokenFromGh();
if (!TOKEN) { console.error('No token. Run: gh auth login'); return 1; }

const OLD = process.env.DT_OLD_PASS || (process.stdin.isTTY ? await ask('CURRENT passphrase: ') : '');
const NEW = process.env.DT_NEW_PASS || (process.stdin.isTTY ? await ask('NEW passphrase:     ') : '');
if (!OLD || !NEW) { console.error('Both passphrases are required.'); return 1; }
if (OLD === NEW) { console.error('The new passphrase is the same as the old one.'); return 1; }
if (NEW.length < 8) { console.error('Use at least 8 characters. Longer beats more complicated.'); return 1; }

const H = { Authorization: 'Bearer ' + TOKEN, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
const BASE = CONFIG.api + '/repos/' + OWNER + '/' + CONFIG.repo + '/contents/' + CONFIG.path;

// ── read and decrypt with the OLD passphrase ─────────────────────────────────

const res = await fetch(BASE + '?ref=' + encodeURIComponent(CONFIG.branch), { headers: H, cache: 'no-store' });
if (!res.ok) { console.error('GitHub returned ' + res.status); return 1; }
const meta = await res.json();
const envelope = JSON.parse(Buffer.from(meta.content, 'base64').toString('utf8'));

let doc;
try {
  const salt = Buffer.from(envelope.salt, 'base64');
  const iv = Buffer.from(envelope.iv, 'base64');
  const blob = Buffer.from(envelope.ct, 'base64');
  const key = pbkdf2Sync(OLD, salt, envelope.iter || 310000, 32, 'sha256');
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(blob.subarray(blob.length - 16));
  doc = JSON.parse(Buffer.concat([d.update(blob.subarray(0, blob.length - 16)), d.final()]).toString('utf8'));
} catch {
  console.error('Could not decrypt with the current passphrase. Nothing was changed.');
  return 1;
}

if (doc.version !== SCHEMA_VERSION) { console.error('Unexpected schema version ' + doc.version); return 1; }
const before = reduce(doc);

// A local plaintext safety copy, so a bad rotation can never be the end of the record.
const rescue = join(ROOT, 'rekey-backup.json');
writeFileSync(rescue, JSON.stringify(doc, null, 2), 'utf8');

console.log('');
console.log('Read the archive with the current passphrase.');
console.log('  entries     : ' + doc.events.length);
console.log('  days worked : ' + before.days.length);
console.log('  outstanding : ' + fmtNis(before.balance_agorot) + ' NIS');
console.log('  safety copy : ' + rescue + '  (plaintext, gitignored — delete it once this works)');

// ── re-encrypt with the NEW passphrase ───────────────────────────────────────

const enc = new TextEncoder();
const salt = webcrypto.getRandomValues(new Uint8Array(16));
const iv = webcrypto.getRandomValues(new Uint8Array(12));
const base = await webcrypto.subtle.importKey('raw', enc.encode(NEW), 'PBKDF2', false, ['deriveKey']);
const key = await webcrypto.subtle.deriveKey(
  { name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' },
  base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
);
const ct = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(doc)));
const b64 = (b) => Buffer.from(b).toString('base64');
const next = { v: 1, alg: 'AES-GCM-256', kdf: 'PBKDF2-SHA256', iter: 310000, salt: b64(salt), iv: b64(iv), ct: b64(new Uint8Array(ct)) };

// Prove the new envelope opens BEFORE it is allowed to replace the old one.
const check = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, Buffer.from(next.ct, 'base64'));
const roundTripped = JSON.parse(new TextDecoder().decode(check));
if (JSON.stringify(roundTripped) !== JSON.stringify(doc)) {
  console.error('Re-encryption did not round-trip. Refusing to write. Nothing was changed.');
  return 1;
}
console.log('  re-encrypted and verified to round-trip.');

const put = await fetch(BASE, {
  method: 'PUT',
  headers: { ...H, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    message: 'rekey: re-encrypt archive under a new passphrase',
    content: Buffer.from(JSON.stringify(next), 'utf8').toString('base64'),
    sha: meta.sha,
    branch: CONFIG.branch,
    committer: { name: CONFIG.commitName, email: CONFIG.commitEmail },
  }),
});
if (!put.ok) { console.error('PUT failed ' + put.status + '. Nothing was changed.'); return 1; }

console.log('');
console.log('DONE. The archive is now locked with the new passphrase.');
console.log('');
console.log('Next, and it is not optional:');
console.log('  1. On the phone: Setup -> Passphrase -> type the new one -> Save & sync now');
console.log('  2. Press "Check my backup". It must say your backup is safe.');
console.log('  3. Delete ' + rescue);
console.log('');
console.log('Note: commits made BEFORE this one are still readable with the old');
console.log('passphrase. Rotation protects what happens from now on.');
console.log('');
return 0;
}

const code = await main();
if (code) process.exitCode = code;
// Release stdin so Node can exit on its own. Calling process.exit() here races the
// readline handle on Windows and aborts with a libuv assertion instead of exiting.
try { process.stdin.pause(); } catch {}
