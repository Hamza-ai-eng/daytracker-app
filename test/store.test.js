// Pure helpers out of store.js. IndexedDB itself is exercised on the device,
// not here — but the merge rule decides whether data survives a conflict, so it
// gets pinned in the suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeEvents, remoteHasEvery, newId, nowStamp, today } from '../src/store.js';

const ev = (id, at) => ({ id, type: 'day', date: '2026-08-03', recorded_at: at });

test('merge keeps everything from both sides', () => {
  const local = [ev('a', '2026-08-03T10:00:00Z'), ev('b', '2026-08-04T10:00:00Z')];
  const remote = [ev('c', '2026-08-05T10:00:00Z')];
  const out = mergeEvents(local, remote);
  assert.deepEqual(out.map((e) => e.id), ['a', 'b', 'c']);
});

test('merge does not duplicate an event present on both sides', () => {
  const local = [ev('a', '2026-08-03T10:00:00Z'), ev('b', '2026-08-04T10:00:00Z')];
  const remote = [ev('b', '2026-08-04T10:00:00Z'), ev('c', '2026-08-05T10:00:00Z')];
  const out = mergeEvents(local, remote);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((e) => e.id), ['a', 'b', 'c']);
});

test('merge orders by recorded_at so replay stays deterministic', () => {
  const local = [ev('late', '2026-08-09T10:00:00Z')];
  const remote = [ev('early', '2026-08-01T10:00:00Z')];
  assert.deepEqual(mergeEvents(local, remote).map((e) => e.id), ['early', 'late']);
});

test('merge with an empty side is a no-op', () => {
  const local = [ev('a', '2026-08-03T10:00:00Z')];
  assert.deepEqual(mergeEvents(local, []).map((e) => e.id), ['a']);
  assert.deepEqual(mergeEvents([], local).map((e) => e.id), ['a']);
  assert.deepEqual(mergeEvents([], []), []);
});

test('merge discards malformed entries without an id rather than crashing', () => {
  const out = mergeEvents([ev('a', '2026-08-03T10:00:00Z'), null, {}], []);
  assert.deepEqual(out.map((e) => e.id), ['a']);
});

test('newId produces unique ids', () => {
  const set = new Set();
  for (let i = 0; i < 500; i++) set.add(newId());
  assert.equal(set.size, 500);
});

test('today is a local calendar date, not a UTC-shifted one', () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  assert.equal(today(), d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()));
  assert.match(today(), /^\d{4}-\d{2}-\d{2}$/);
});

test('nowStamp carries a local offset and parses back to now', () => {
  const s = nowStamp();
  assert.match(s, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.ok(Math.abs(Date.parse(s) - Date.now()) < 5000, 'must round-trip to roughly now');
});

// remoteHasEvery decides whether a push is skipped. A false yes silently skips a
// backup; a false no commits an identical file every time the app is opened.

test('remote holding everything means there is nothing to push', () => {
  const a = ev('a', '2026-08-01T10:00:00Z');
  const b = ev('b', '2026-08-02T10:00:00Z');
  assert.equal(remoteHasEvery([a, b], [a, b]), true);
  assert.equal(remoteHasEvery([a], [a, b]), true, 'remote ahead of us is still up to date');
});

test('a missing event means we must push, even at equal length', () => {
  const a = ev('a', '2026-08-01T10:00:00Z');
  const b = ev('b', '2026-08-02T10:00:00Z');
  const c = ev('c', '2026-08-03T10:00:00Z');
  assert.equal(remoteHasEvery([a, b], [a, c]), false, 'same count, different events');
  assert.equal(remoteHasEvery([a, b], [a]), false);
});

test('an empty or absent remote always needs a push when we have anything', () => {
  const a = ev('a', '2026-08-01T10:00:00Z');
  assert.equal(remoteHasEvery([a], []), false);
  assert.equal(remoteHasEvery([a], undefined), false);
  assert.equal(remoteHasEvery([], []), true, 'nothing to push when we have nothing');
});
