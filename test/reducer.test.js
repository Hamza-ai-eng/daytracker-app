// node --test test/
// Zero dependencies. Node's built-in runner only.
//
// This suite is the reason the reducer is a pure module. A wrong reducer produces a
// wrong balance SILENTLY, which is worse than a crash — so every money path is pinned.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  reduce,
  validate,
  rateOn,
  loggedAfterDays,
  byDate,
  fmtNis,
  DataError,
  SCHEMA_VERSION,
} from '../src/reducer.js';

const RATE = { id: 'r1', type: 'rate_set', effective_from: '2026-01-01', rate_agorot: 40000, recorded_at: '2026-01-01T00:00:00+03:00' };

const doc = (...events) => ({ version: SCHEMA_VERSION, events: [RATE, ...events] });

const day = (o) => ({
  id: o.id || 'd-' + o.date,
  type: 'day',
  date: o.date,
  recorded_at: o.recorded_at || o.date + 'T21:00:00+03:00',
  worked: o.worked !== undefined ? o.worked : true,
  portion: o.portion || 'full',
  streams: o.streams || ['ops'],
  note: o.note || '',
  ...(o.deleted ? { deleted: true } : {}),
});

const pay = (o) => ({
  id: o.id,
  type: 'payment',
  date: o.date,
  recorded_at: o.recorded_at || o.date + 'T20:00:00+03:00',
  amount_agorot: o.amount_agorot,
  method: o.method || 'cash',
  note: o.note || '',
  ...(o.ref ? { ref: o.ref } : {}),
  ...(o.deleted ? { deleted: true } : {}),
});

// ── day valuation ────────────────────────────────────────────────────────────

test('a full day is worth the full rate', () => {
  const s = reduce(doc(day({ date: '2026-08-03' })));
  assert.equal(s.days.length, 1);
  assert.equal(s.days[0].value_agorot, 40000);
  assert.equal(s.earned_agorot, 40000);
});

test('a half day is worth half the rate', () => {
  const s = reduce(doc(day({ date: '2026-08-03', portion: 'half' })));
  assert.equal(s.days[0].value_agorot, 20000);
  assert.equal(s.earned_agorot, 20000);
});

test('a not-worked day earns nothing and does not appear in days', () => {
  const s = reduce(doc(day({ date: '2026-08-03', worked: false })));
  assert.equal(s.days.length, 0);
  assert.equal(s.earned_agorot, 0);
});

test('a day tagged with BOTH streams is still ONE day at one rate', () => {
  const s = reduce(doc(day({ date: '2026-08-03', streams: ['ops', 'campaign'] })));
  assert.equal(s.days.length, 1);
  assert.equal(s.earned_agorot, 40000, 'must not double-count');
  const m = s.months[0];
  assert.equal(m.days, 1);
  assert.equal(m.byStream.ops, 1);
  assert.equal(m.byStream.campaign, 1);
  assert.equal(m.earned_agorot, 40000);
});

// ── corrections ──────────────────────────────────────────────────────────────

test('a later event for the same date supersedes the earlier one', () => {
  const s = reduce(
    doc(
      day({ id: 'a', date: '2026-08-03', portion: 'full', recorded_at: '2026-08-03T21:00:00+03:00' }),
      day({ id: 'b', date: '2026-08-03', portion: 'half', recorded_at: '2026-08-05T09:00:00+03:00' })
    )
  );
  assert.equal(s.days.length, 1);
  assert.equal(s.days[0].portion, 'half');
  assert.equal(s.earned_agorot, 20000);
});

test('correction wins by recorded_at even when events arrive out of order', () => {
  const s = reduce(
    doc(
      day({ id: 'b', date: '2026-08-03', portion: 'half', recorded_at: '2026-08-05T09:00:00+03:00' }),
      day({ id: 'a', date: '2026-08-03', portion: 'full', recorded_at: '2026-08-03T21:00:00+03:00' })
    )
  );
  assert.equal(s.days[0].portion, 'half', 'the newer recorded_at must win regardless of array order');
});

test('recorded_at is compared across timezone offsets, not as a string', () => {
  // 2026-08-03T23:00:00+03:00 == 20:00Z, which is EARLIER than 2026-08-03T22:00:00Z.
  const s = reduce(
    doc(
      day({ id: 'a', date: '2026-08-03', portion: 'full', recorded_at: '2026-08-03T23:00:00+03:00' }),
      day({ id: 'b', date: '2026-08-03', portion: 'half', recorded_at: '2026-08-03T22:00:00Z' })
    )
  );
  assert.equal(s.days[0].portion, 'half');
});

test('a day can be un-marked by a later worked:false event', () => {
  const s = reduce(
    doc(
      day({ id: 'a', date: '2026-08-03', recorded_at: '2026-08-03T21:00:00+03:00' }),
      day({ id: 'b', date: '2026-08-03', worked: false, recorded_at: '2026-08-04T10:00:00+03:00' })
    )
  );
  assert.equal(s.days.length, 0);
  assert.equal(s.earned_agorot, 0);
});

test('a deleted day is dropped', () => {
  const s = reduce(
    doc(
      day({ id: 'a', date: '2026-08-03', recorded_at: '2026-08-03T21:00:00+03:00' }),
      { id: 'b', type: 'day', date: '2026-08-03', deleted: true, recorded_at: '2026-08-06T10:00:00+03:00' }
    )
  );
  assert.equal(s.days.length, 0);
});

test('nothing is destroyed: the source events are left untouched by reduce', () => {
  const d = doc(day({ date: '2026-08-03' }), day({ date: '2026-08-04' }));
  const before = JSON.stringify(d);
  reduce(d);
  assert.equal(JSON.stringify(d), before, 'reduce must not mutate the event log');
});

// ── rates over time ──────────────────────────────────────────────────────────

test('a rate change does not re-price historical days', () => {
  const s = reduce({
    version: SCHEMA_VERSION,
    events: [
      RATE,
      { id: 'r2', type: 'rate_set', effective_from: '2027-01-01', rate_agorot: 45000, recorded_at: '2026-12-20T10:00:00+03:00' },
      day({ date: '2026-08-03' }),
      day({ date: '2027-02-03' }),
    ],
  });
  const m = byDate(s);
  assert.equal(m.get('2026-08-03').value_agorot, 40000, '2026 day keeps the 400 rate');
  assert.equal(m.get('2027-02-03').value_agorot, 45000, '2027 day uses the 450 rate');
  assert.equal(s.earned_agorot, 85000);
  assert.equal(s.currentRate, 45000);
});

test('a day predating every rate uses the earliest rate rather than throwing', () => {
  const s = reduce(doc(day({ date: '2025-12-30' })));
  assert.equal(s.days[0].value_agorot, 40000);
});

test('rateOn picks the rate in force on the boundary date itself', () => {
  const rates = [
    { effective_from: '2026-01-01', rate_agorot: 40000 },
    { effective_from: '2027-01-01', rate_agorot: 45000 },
  ];
  assert.equal(rateOn(rates, '2026-12-31'), 40000);
  assert.equal(rateOn(rates, '2027-01-01'), 45000, 'effective_from is inclusive');
});

test('rateOn throws when no rate exists at all', () => {
  assert.throws(() => rateOn([], '2026-08-03'), DataError);
});

// ── payments ─────────────────────────────────────────────────────────────────

test('multiple payments sum', () => {
  const s = reduce(
    doc(pay({ id: 'p1', date: '2026-08-10', amount_agorot: 200000 }), pay({ id: 'p2', date: '2026-08-20', amount_agorot: 150000 }))
  );
  assert.equal(s.payments.length, 2);
  assert.equal(s.received_agorot, 350000);
});

test('a corrected payment supersedes the original via ref', () => {
  const s = reduce(
    doc(
      pay({ id: 'p1', date: '2026-08-10', amount_agorot: 200000, recorded_at: '2026-08-10T20:00:00+03:00' }),
      pay({ id: 'p1-fix', ref: 'p1', date: '2026-08-10', amount_agorot: 180000, recorded_at: '2026-08-12T20:00:00+03:00' })
    )
  );
  assert.equal(s.payments.length, 1, 'a correction must not add a second payment');
  assert.equal(s.received_agorot, 180000);
});

test('a deleted payment is dropped', () => {
  const s = reduce(
    doc(
      pay({ id: 'p1', date: '2026-08-10', amount_agorot: 200000, recorded_at: '2026-08-10T20:00:00+03:00' }),
      { id: 'p1-del', type: 'payment', ref: 'p1', deleted: true, recorded_at: '2026-08-11T20:00:00+03:00' }
    )
  );
  assert.equal(s.payments.length, 0);
  assert.equal(s.received_agorot, 0);
});

test('payments are listed newest first', () => {
  const s = reduce(
    doc(pay({ id: 'p1', date: '2026-08-10', amount_agorot: 100 }), pay({ id: 'p2', date: '2026-09-10', amount_agorot: 100 }))
  );
  assert.equal(s.payments[0].date, '2026-09-10');
});

// ── the headline number ──────────────────────────────────────────────────────

test('balance = earned - received across a mixed month', () => {
  const s = reduce(
    doc(
      day({ date: '2026-08-03' }),                                      // 400
      day({ date: '2026-08-04', portion: 'half' }),                     // 200
      day({ date: '2026-08-05', streams: ['ops', 'campaign'] }),        // 400
      day({ date: '2026-08-06', worked: false }),                       //   0
      day({ date: '2026-08-07', portion: 'half', streams: ['campaign'] }), // 200
      pay({ id: 'p1', date: '2026-08-20', amount_agorot: 100000 })      // -1000
    )
  );
  assert.equal(s.earned_agorot, 120000, 'earned = 400+200+400+200 = 1200 NIS');
  assert.equal(s.received_agorot, 100000);
  assert.equal(s.balance_agorot, 20000, 'outstanding = 200 NIS');

  const m = s.months[0];
  assert.equal(m.month, '2026-08');
  assert.equal(m.days, 4);
  assert.equal(m.full, 2);
  assert.equal(m.half, 2);
  assert.equal(m.byStream.ops, 3);
  assert.equal(m.byStream.campaign, 2);
});

test('balance goes negative when overpaid, and says so rather than clamping', () => {
  const s = reduce(doc(day({ date: '2026-08-03' }), pay({ id: 'p1', date: '2026-08-04', amount_agorot: 50000 })));
  assert.equal(s.balance_agorot, -10000);
});

test('an empty log is zero everywhere, not NaN', () => {
  const s = reduce(doc());
  assert.equal(s.earned_agorot, 0);
  assert.equal(s.received_agorot, 0);
  assert.equal(s.balance_agorot, 0);
  assert.deepEqual(s.days, []);
  assert.deepEqual(s.months, []);
});

// ── backfill visibility ──────────────────────────────────────────────────────

test('a day logged the same evening reads as contemporaneous', () => {
  const s = reduce(doc(day({ date: '2026-08-03', recorded_at: '2026-08-03T22:30:00+03:00' })));
  assert.equal(s.days[0].logged_after_days, 0);
});

test('a backfilled day carries how late it was entered', () => {
  const s = reduce(doc(day({ date: '2026-08-03', recorded_at: '2026-08-24T22:30:00+03:00' })));
  assert.equal(s.days[0].logged_after_days, 21);
});

test('loggedAfterDays uses the local calendar day of entry', () => {
  assert.equal(loggedAfterDays('2026-08-03', '2026-08-04T01:00:00Z'), 1);
});

// ── loud failure ─────────────────────────────────────────────────────────────

test('a wrong schema version throws instead of returning zeros', () => {
  assert.throws(() => reduce({ version: 2, events: [] }), DataError);
  assert.throws(() => reduce({ version: undefined, events: [] }), DataError);
});

test('a malformed document throws', () => {
  assert.throws(() => reduce(null), DataError);
  assert.throws(() => reduce({ version: SCHEMA_VERSION }), DataError);
  assert.throws(() => reduce({ version: SCHEMA_VERSION, events: 'nope' }), DataError);
});

test('an unknown event type throws rather than being ignored', () => {
  assert.throws(
    () => reduce({ version: SCHEMA_VERSION, events: [{ id: 'x', type: 'wat', recorded_at: '2026-08-03T00:00:00Z' }] }),
    DataError
  );
});

test('a bad portion, stream, date or amount throws', () => {
  const bad = (e) => () => reduce(doc(e));
  assert.throws(bad({ id: 'x', type: 'day', date: '2026-08-03', recorded_at: '2026-08-03T00:00:00Z', worked: true, portion: 'quarter', streams: ['ops'] }), DataError);
  assert.throws(bad({ id: 'x', type: 'day', date: '2026-08-03', recorded_at: '2026-08-03T00:00:00Z', worked: true, portion: 'full', streams: ['kitchen'] }), DataError);
  assert.throws(bad({ id: 'x', type: 'day', date: '2026-08-03', recorded_at: '2026-08-03T00:00:00Z', worked: true, portion: 'full', streams: [] }), DataError);
  assert.throws(bad({ id: 'x', type: 'day', date: '03/08/2026', recorded_at: '2026-08-03T00:00:00Z', worked: true, portion: 'full', streams: ['ops'] }), DataError);
  assert.throws(bad({ id: 'x', type: 'payment', date: '2026-08-03', recorded_at: '2026-08-03T00:00:00Z', amount_agorot: 100.5 }), DataError);
  assert.throws(bad({ id: 'x', type: 'payment', date: '2026-08-03', recorded_at: '2026-08-03T00:00:00Z', amount_agorot: -100 }), DataError);
  assert.throws(bad({ id: 'x', type: 'day', date: '2026-08-03', recorded_at: 'not-a-time', worked: true, portion: 'full', streams: ['ops'] }), DataError);
});

test('validate accepts a well-formed document', () => {
  assert.equal(validate(doc(day({ date: '2026-08-03' }), pay({ id: 'p1', date: '2026-08-04', amount_agorot: 1 }))), true);
});

// ── money never touches floating point ───────────────────────────────────────

test('summing many half days stays exact', () => {
  const events = [];
  for (let i = 1; i <= 31; i++) {
    events.push(day({ date: '2026-08-' + String(i).padStart(2, '0'), portion: 'half' }));
  }
  const s = reduce(doc(...events));
  assert.equal(s.earned_agorot, 31 * 20000);
  assert.equal(Number.isInteger(s.earned_agorot), true);
});

test('odd-agorot amounts sum exactly', () => {
  const s = reduce(
    doc(
      pay({ id: 'p1', date: '2026-08-01', amount_agorot: 10 }),
      pay({ id: 'p2', date: '2026-08-02', amount_agorot: 20 }),
      pay({ id: 'p3', date: '2026-08-03', amount_agorot: 33 })
    )
  );
  assert.equal(s.received_agorot, 63);
});

test('fmtNis renders agorot as readable NIS', () => {
  assert.equal(fmtNis(40000), '400');
  assert.equal(fmtNis(20050), '200.50');
  assert.equal(fmtNis(1234567), '12,345.67');
  assert.equal(fmtNis(-20000), '-200');
  assert.equal(fmtNis(0), '0');
});
