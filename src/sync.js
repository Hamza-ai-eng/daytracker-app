// sync.js — the encrypted archive at GitHub.
//
// Verified before building: api.github.com returns `Access-Control-Allow-Origin: *`,
// so the phone talks to it directly. No server, nothing to host, nothing to keep alive.
//
// Two rules that matter more than the code:
//   1. Sync fires IMMEDIATELY on write, never on a timer. MIUI kills backgrounded
//      apps hard, and a pending timer may simply never run.
//   2. If the remote exists but will not decrypt, we STOP. We never overwrite a file
//      we cannot read — that is how a year of records gets destroyed by a typo.

import { CONFIG, KEYS } from './config.js';
import { encryptDoc, decryptDoc, bytesToB64, DecryptError } from './crypto.js';
import { buildDoc, allEvents, replaceAll, mergeEvents, remoteHasEvery } from './store.js';
import { SCHEMA_VERSION } from './reducer.js';

const enc = new TextEncoder();
const MAX_ATTEMPTS = 4;

export const get = (k) => localStorage.getItem(k) || '';
export const set = (k, v) => (v ? localStorage.setItem(k, v) : localStorage.removeItem(k));

export function owner() {
  return get(KEYS.owner) || CONFIG.owner;
}

export function isConfigured() {
  return Boolean(get(KEYS.token) && get(KEYS.passphrase) && owner() && owner() !== 'CHANGE_ME');
}

function fileUrl() {
  return (
    CONFIG.api + '/repos/' + owner() + '/' + CONFIG.repo + '/contents/' + CONFIG.path +
    '?ref=' + encodeURIComponent(CONFIG.branch)
  );
}

function putUrl() {
  return CONFIG.api + '/repos/' + owner() + '/' + CONFIG.repo + '/contents/' + CONFIG.path;
}

function headers() {
  return {
    Authorization: 'Bearer ' + get(KEYS.token),
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

export class SyncError extends Error {
  constructor(msg, kind) {
    super(msg);
    this.name = 'SyncError';
    this.kind = kind || 'unknown';
  }
}

function explain(res) {
  if (res.status === 401) return new SyncError('GitHub rejected the token (401). It may have expired — create a new one.', 'auth');
  if (res.status === 403) return new SyncError('GitHub refused (403). Token lacks Contents write permission, or you are rate limited.', 'auth');
  if (res.status === 404) return new SyncError('Repo or path not found (404). Check the owner name and that the token can see ' + CONFIG.repo + '.', 'config');
  if (res.status === 409 || res.status === 422) return new SyncError('Conflict — the file moved on while writing.', 'conflict');
  return new SyncError('GitHub error ' + res.status, 'http');
}

/** Fetch and decrypt the archive. Returns {doc, sha} or {doc:null, sha:null} if absent. */
export async function fetchRemote() {
  const res = await fetch(fileUrl(), { headers: headers(), cache: 'no-store' });
  if (res.status === 404) return { doc: null, sha: null };
  if (!res.ok) throw explain(res);

  const meta = await res.json();
  const raw = atob(String(meta.content || '').replace(/\s/g, ''));
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new SyncError('The archive file is not valid JSON. Refusing to overwrite it.', 'corrupt');
  }
  const doc = await decryptDoc(envelope, get(KEYS.passphrase));
  return { doc, sha: meta.sha };
}

async function putFile(text, sha, message) {
  const body = {
    message,
    content: bytesToB64(enc.encode(text)),
    branch: CONFIG.branch,
    committer: { name: CONFIG.commitName, email: CONFIG.commitEmail },
  };
  if (sha) body.sha = sha;

  const res = await fetch(putUrl(), {
    method: 'PUT',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw explain(res);
  return res.json();
}

/**
 * Push the local log to GitHub.
 *
 * Every push reads the remote first and unions the two event lists by id. That makes
 * "the phone is the only writer" a safety net rather than a load-bearing assumption:
 * even if something else ever wrote, nothing is discarded from either side.
 */
export async function push(reason) {
  if (!isConfigured()) throw new SyncError('Not set up yet — add owner, token and passphrase in Settings.', 'config');

  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const local = await allEvents();
      const { doc: remote, sha } = await fetchRemote();

      let events = local;
      let remoteHasAll = false;

      if (remote) {
        if (remote.version !== SCHEMA_VERSION) {
          throw new SyncError('The archive uses schema version ' + remote.version + ', this app expects ' + SCHEMA_VERSION + '. Not overwriting.', 'schema');
        }
        const remoteEvents = remote.events || [];
        events = mergeEvents(local, remoteEvents);

        // The remote brought us something we did not have — take it before anything else.
        if (events.length !== local.length) await replaceAll(events);

        remoteHasAll = remoteHasEvery(events, remoteEvents);
      }

      if (remoteHasAll) {
        set(KEYS.lastSha, sha);
        set(KEYS.lastSync, new Date().toISOString());
        set(KEYS.syncError, '');
        return { pushed: false, events: events.length };
      }

      const doc = { version: SCHEMA_VERSION, events };
      const envelope = await encryptDoc(doc, get(KEYS.passphrase));
      const msg = (reason || 'update') + ' — ' + events.length + ' events';
      const out = await putFile(JSON.stringify(envelope, null, 0), sha, msg);

      set(KEYS.lastSha, out && out.content ? out.content.sha : '');
      set(KEYS.lastSync, new Date().toISOString());
      set(KEYS.syncError, '');
      return { pushed: true, events: events.length };
    } catch (e) {
      lastErr = e;
      // A conflict is worth retrying: re-read, re-merge, re-push.
      if (e instanceof SyncError && e.kind === 'conflict' && attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 250 * attempt));
        continue;
      }
      // Anything else — auth, corrupt, wrong passphrase — must not be retried blindly.
      break;
    }
  }

  set(KEYS.syncError, lastErr ? lastErr.message : 'Unknown sync failure');
  throw lastErr;
}

/** Restore: pull the archive down and replace whatever is on the phone. */
export async function pull() {
  if (!isConfigured()) throw new SyncError('Not set up yet — add owner, token and passphrase in Settings.', 'config');
  const { doc, sha } = await fetchRemote();
  if (!doc) throw new SyncError('There is no archive at ' + CONFIG.path + ' yet.', 'empty');
  if (doc.version !== SCHEMA_VERSION) {
    throw new SyncError('Archive schema version ' + doc.version + ' cannot be read by this app.', 'schema');
  }
  const n = await replaceAll(doc.events || []);
  set(KEYS.lastSha, sha);
  set(KEYS.lastSync, new Date().toISOString());
  set(KEYS.syncError, '');
  return n;
}

/**
 * Fire-and-forget push used by every write path. Never throws into the UI —
 * it records the failure so the status line can shout about it instead.
 */
export function pushSoon(reason, onDone) {
  if (!isConfigured()) {
    if (onDone) onDone(null, new SyncError('Not set up yet', 'config'));
    return;
  }
  push(reason).then(
    (r) => onDone && onDone(r, null),
    (e) => onDone && onDone(null, e)
  );
}

export function lastSyncText() {
  const err = get(KEYS.syncError);
  const iso = get(KEYS.lastSync);
  if (!isConfigured()) return { text: 'Not backed up — set up sync', bad: true };
  if (err) return { text: 'Sync failing: ' + err, bad: true };
  if (!iso) return { text: 'Never synced', bad: true };

  const mins = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return { text: 'Synced just now', bad: false };
  if (mins < 60) return { text: 'Synced ' + mins + ' min ago', bad: false };
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return { text: 'Synced ' + hrs + 'h ago', bad: false };
  const days = Math.floor(hrs / 24);
  return { text: 'Synced ' + days + ' day' + (days === 1 ? '' : 's') + ' ago', bad: days >= 3 };
}

export { DecryptError };
