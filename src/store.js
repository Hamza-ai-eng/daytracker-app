// store.js — the phone's copy of the event log, in IndexedDB.
//
// Append-only. Nothing is ever updated in place; a correction is a new event.
// `seq` is an autoincrement key so getAll() returns strict insertion order, which
// the reducer relies on to break ties on identical recorded_at timestamps.

import { SCHEMA_VERSION } from './reducer.js';

const DB_NAME = 'daytracker';
const DB_VERSION = 1;
const STORE = 'events';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'seq', autoIncrement: true });
        os.createIndex('id', 'event.id', { unique: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const os = t.objectStore(STORE);
        let result;
        try {
          result = fn(os);
        } catch (e) {
          reject(e);
          return;
        }
        t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

/** Append one event. Returns the event unchanged. */
export async function append(event) {
  await tx('readwrite', (os) => os.add({ event }));
  return event;
}

/** Append many in one transaction. */
export async function appendMany(events) {
  if (!events.length) return 0;
  await tx('readwrite', (os) => {
    for (const event of events) os.add({ event });
  });
  return events.length;
}

/** Every event, in insertion order. */
export async function allEvents() {
  const rows = await tx('readonly', (os) => ({ __req: os.getAll() }));
  return (rows || []).map((r) => r.event);
}

/** The full document, ready to encrypt. */
export async function buildDoc() {
  return { version: SCHEMA_VERSION, events: await allEvents() };
}

/**
 * Replace the entire local log. Used by restore and by conflict merges.
 * Clear and refill happen in ONE transaction, so an interruption cannot leave
 * the phone holding a half-written log.
 */
export async function replaceAll(events) {
  await tx('readwrite', (os) => {
    os.clear();
    for (const event of events) os.add({ event });
  });
  return events.length;
}

export async function count() {
  return tx('readonly', (os) => ({ __req: os.count() }));
}

/**
 * Union two event lists by id, preserving order and preferring the local copy
 * of any duplicate. Used when the remote has moved on since the last push —
 * nothing is ever discarded, from either side.
 */
export function mergeEvents(local, remote) {
  const seen = new Set();
  const out = [];
  for (const e of local) {
    if (e && e.id && !seen.has(e.id)) {
      seen.add(e.id);
      out.push(e);
    }
  }
  for (const e of remote) {
    if (e && e.id && !seen.has(e.id)) {
      seen.add(e.id);
      out.push(e);
    }
  }
  out.sort((a, b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at));
  return out;
}

/**
 * Does the remote already hold every event we have?
 *
 * Compared by id, never by count: two lists can be the same length and still differ.
 * Getting this wrong in either direction is expensive — a false "yes" silently skips
 * a backup, a false "no" commits an identical file on every open.
 */
export function remoteHasEvery(events, remoteEvents) {
  const ids = new Set((remoteEvents || []).map((e) => e && e.id));
  return (events || []).every((e) => ids.has(e.id));
}

/** Crypto-quality event id. No dependency, no collision worry. */
export function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** ISO timestamp WITH the local offset, so backfill distance stays meaningful. */
export function nowStamp() {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return (
    d.getFullYear() +
    '-' + pad(d.getMonth() + 1) +
    '-' + pad(d.getDate()) +
    'T' + pad(d.getHours()) +
    ':' + pad(d.getMinutes()) +
    ':' + pad(d.getSeconds()) +
    sign + pad(off / 60) + ':' + pad(off % 60)
  );
}

/** Local calendar date as YYYY-MM-DD. Never toISOString() — that shifts to UTC. */
export function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
