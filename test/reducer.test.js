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
  datesInRange,
  parseDateList,
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

// ── date ranges for bulk backfill ────────────────────────────────────────────
// These write real paid days into the record in one action. A fencepost error
// here silently adds or drops 400 NIS, so the boundaries are pinned exactly.

test('every Friday from 1 June to 25 August 2026 is exactly 12 dates', () => {
  const out = datesInRange('2026-06-01', '2026-08-25', [5]);
  assert.equal(out.length, 12);
  assert.equal(out[0], '2026-06-05', 'first Friday on or after Monday 1 June');
  assert.equal(out[out.length - 1], '2026-08-21', '28 Aug is past the end date');
  assert.deepEqual(out, [
    '2026-06-05','2026-06-12','2026-06-19','2026-06-26',
    '2026-07-03','2026-07-10','2026-07-17','2026-07-24','2026-07-31',
    '2026-08-07','2026-08-14','2026-08-21',
  ]);
});

test('both ends of the range are inclusive', () => {
  // 2026-06-05 is a Friday; asking for exactly that day returns it.
  assert.deepEqual(datesInRange('2026-06-05', '2026-06-05', [5]), ['2026-06-05']);
  // A range ending ON a Friday includes it.
  assert.equal(datesInRange('2026-06-01', '2026-06-05', [5]).length, 1);
  // A range ending the day before excludes it.
  assert.equal(datesInRange('2026-06-01', '2026-06-04', [5]).length, 0);
});

test('several weekdays at once, in date order', () => {
  const out = datesInRange('2026-06-01', '2026-06-14', [1, 5]); // Mondays + Fridays
  assert.deepEqual(out, ['2026-06-01', '2026-06-05', '2026-06-08', '2026-06-12']);
});

test('ranges spanning a month and a year boundary do not drop a day', () => {
  assert.deepEqual(datesInRange('2026-01-29', '2026-02-02', [0,1,2,3,4,5,6]),
    ['2026-01-29','2026-01-30','2026-01-31','2026-02-01','2026-02-02']);
  assert.deepEqual(datesInRange('2026-12-30', '2027-01-02', [0,1,2,3,4,5,6]),
    ['2026-12-30','2026-12-31','2027-01-01','2027-01-02']);
});

test('February in a leap year keeps the 29th', () => {
  const out = datesInRange('2028-02-27', '2028-03-01', [0,1,2,3,4,5,6]);
  assert.deepEqual(out, ['2028-02-27','2028-02-28','2028-02-29','2028-03-01']);
});

test('no weekdays chosen, or a backwards range, returns nothing', () => {
  assert.deepEqual(datesInRange('2026-06-01', '2026-08-25', []), []);
  assert.deepEqual(datesInRange('2026-08-25', '2026-06-01', [5]), []);
});

test('a malformed date throws rather than guessing', () => {
  assert.throws(() => datesInRange('01/06/2026', '2026-08-25', [5]), DataError);
});

test('backfilled Fridays price to 4,800 NIS at 400/day', () => {
  const dates = datesInRange('2026-06-01', '2026-08-25', [5]);
  const events = dates.map((d, i) => ({
    id: 'bf' + i, type: 'day', date: d, recorded_at: '2026-08-25T12:00:00+03:00',
    worked: true, portion: 'full', streams: ['ops'], note: '',
  }));
  const s = reduce(doc(...events, pay({ id: 'p', date: '2026-08-12', amount_agorot: 200000 })));
  assert.equal(s.days.length, 12);
  assert.equal(s.earned_agorot, 480000);
  assert.equal(s.received_agorot, 200000);
  assert.equal(s.balance_agorot, 280000, '2,800 NIS outstanding');
});

// ── pasted date lists ────────────────────────────────────────────────────────

test('the exact list of extra days parses to 7 dates', () => {
  const r = parseDateList('2026-06-15, 2026-06-16, 2026-06-17, 2026-07-30, 2026-08-01, 2026-08-06, 2026-08-08');
  assert.deepEqual(r.bad, []);
  assert.deepEqual(r.dates, [
    '2026-06-15','2026-06-16','2026-06-17','2026-07-30','2026-08-01','2026-08-06','2026-08-08',
  ]);
});

test('separators can be commas, spaces or new lines, and order does not matter', () => {
  const r = parseDateList('2026-08-08\n2026-06-15  2026-07-30,2026-06-16');
  assert.deepEqual(r.dates, ['2026-06-15','2026-06-16','2026-07-30','2026-08-08']);
});

test('day-first slash dates are accepted', () => {
  assert.deepEqual(parseDateList('15/06/2026 1.8.2026').dates, ['2026-06-15','2026-08-01']);
});

test('duplicates collapse instead of double-charging a day', () => {
  assert.deepEqual(parseDateList('2026-06-15, 2026-06-15, 15/06/2026').dates, ['2026-06-15']);
});

test('anything not understood is reported, never silently dropped', () => {
  const r = parseDateList('2026-06-15, next friday, 2026-13-40, 2026-02-31');
  assert.deepEqual(r.dates, ['2026-06-15']);
  assert.deepEqual(r.bad, ['next', 'friday', '2026-13-40', '2026-02-31']);
});

test('empty input is empty, not an error', () => {
  assert.deepEqual(parseDateList('').dates, []);
  assert.deepEqual(parseDateList(null).bad, []);
});

test('Fridays plus the extra days total 19 unique days = 7,600 NIS', () => {
  const fridays = datesInRange('2026-06-01', '2026-08-25', [5]);
  const extra = parseDateList('2026-06-15, 2026-06-16, 2026-06-17, 2026-07-30, 2026-08-01, 2026-08-06, 2026-08-08').dates;
  const all = [...new Set([...fridays, ...extra])].sort();
  assert.equal(all.length, 19, 'no overlap between the two lists');

  const events = all.map((d, i) => ({
    id: 'x' + i, type: 'day', date: d, recorded_at: '2026-08-25T12:00:00+03:00',
    worked: true, portion: 'full', streams: ['ops'], note: '',
  }));
  const s = reduce(doc(...events, pay({ id: 'p', date: '2026-08-12', amount_agorot: 200000 })));
  assert.equal(s.earned_agorot, 760000, '7,600 NIS earned');
  assert.equal(s.balance_agorot, 560000, '5,600 NIS outstanding');
  assert.equal(s.months.find((m) => m.month === '2026-06').days, 7);
  assert.equal(s.months.find((m) => m.month === '2026-07').days, 6);
  assert.equal(s.months.find((m) => m.month === '2026-08').days, 6);
});

// ── monthly retainer ─────────────────────────────────────────────────────────
// A flat monthly fee, separate from day work. Charged on the 1st of each month
// from the month it starts, through the month being viewed.

const RET = (from_month, nis, at) => ({
  id: 'ret-' + from_month, type: 'retainer_set', from_month,
  amount_agorot: nis * 100, recorded_at: at || '2026-08-25T12:00:00+03:00',
});

test('a retainer starting in June charges June, July and August by 25 August', () => {
  const s = reduce(doc(RET('2026-06', 2000)), '2026-08-25');
  assert.equal(s.retainerCharges.length, 3);
  assert.deepEqual(s.retainerCharges.map((c) => c.month), ['2026-06', '2026-07', '2026-08']);
  assert.equal(s.earnedRetainer_agorot, 600000, '3 x 2,000 = 6,000 NIS');
  assert.equal(s.earnedDays_agorot, 0);
  assert.equal(s.earned_agorot, 600000);
});

test('the current month is charged as soon as it begins', () => {
  assert.equal(reduce(doc(RET('2026-06', 2000)), '2026-08-01').retainerCharges.length, 3);
  assert.equal(reduce(doc(RET('2026-06', 2000)), '2026-07-31').retainerCharges.length, 2);
});

test('a retainer does not charge for months before it starts', () => {
  const s = reduce(doc(RET('2026-06', 2000)), '2026-06-01');
  assert.deepEqual(s.retainerCharges.map((c) => c.month), ['2026-06']);
});

test('changing the amount applies from that month onward only', () => {
  const s = reduce(doc(RET('2026-06', 2000), RET('2026-08', 2500)), '2026-08-25');
  assert.deepEqual(s.retainerCharges, [
    { month: '2026-06', amount_agorot: 200000 },
    { month: '2026-07', amount_agorot: 200000 },
    { month: '2026-08', amount_agorot: 250000 },
  ]);
  assert.equal(s.earnedRetainer_agorot, 650000);
});

test('setting the retainer to zero stops it without erasing history', () => {
  const s = reduce(doc(RET('2026-06', 2000), RET('2026-08', 0)), '2026-10-15');
  assert.deepEqual(s.retainerCharges.map((c) => c.month), ['2026-06', '2026-07']);
  assert.equal(s.earnedRetainer_agorot, 400000);
});

test('a retainer crossing the new year keeps counting', () => {
  const s = reduce(doc(RET('2026-11', 1000)), '2027-02-10');
  assert.deepEqual(s.retainerCharges.map((c) => c.month), ['2026-11', '2026-12', '2027-01', '2027-02']);
});

test('retainer months show up in the monthly rollup even with no days worked', () => {
  const s = reduce(doc(RET('2026-06', 2000)), '2026-07-15');
  const june = s.months.find((m) => m.month === '2026-06');
  assert.equal(june.days, 0);
  assert.equal(june.retainer_agorot, 200000);
  assert.equal(june.earned_agorot, 200000);
});

test('reduce is pure: no clock, same answer every time', () => {
  const d = doc(RET('2026-06', 2000), day({ date: '2026-08-03' }));
  assert.equal(reduce(d, '2026-08-25').earned_agorot, reduce(d, '2026-08-25').earned_agorot);
  // With no asOf it falls back to the latest date in the log, never to today.
  assert.equal(reduce(d).asOf, '2026-08-25');
});

test('a bad retainer event throws', () => {
  assert.throws(() => reduce(doc({ id: 'x', type: 'retainer_set', from_month: '2026-06-01', amount_agorot: 1000, recorded_at: '2026-08-25T00:00:00Z' })), DataError);
  assert.throws(() => reduce(doc({ id: 'x', type: 'retainer_set', from_month: '2026-06', amount_agorot: -1, recorded_at: '2026-08-25T00:00:00Z' })), DataError);
  assert.throws(() => reduce(doc({ id: 'x', type: 'retainer_set', from_month: '2026-06', amount_agorot: 10.5, recorded_at: '2026-08-25T00:00:00Z' })), DataError);
});

// ── the whole picture, as requested ──────────────────────────────────────────

test('19 days + 3 months retainer - 2,000 paid = 11,600 outstanding', () => {
  const fridays = datesInRange('2026-06-01', '2026-08-25', [5]);
  const extra = parseDateList('2026-06-15, 2026-06-16, 2026-06-17, 2026-07-30, 2026-08-01, 2026-08-06, 2026-08-08').dates;
  const all = [...new Set([...fridays, ...extra])].sort();
  assert.equal(all.length, 19);

  const events = all.map((d, i) => ({
    id: 'x' + i, type: 'day', date: d, recorded_at: '2026-08-25T12:00:00+03:00',
    worked: true, portion: 'full', streams: ['ops'], note: '',
  }));

  const s = reduce(
    doc(...events, RET('2026-06', 2000), pay({ id: 'p', date: '2026-08-12', amount_agorot: 200000 })),
    '2026-08-25'
  );

  assert.equal(s.earnedDays_agorot, 760000, '19 days x 400 = 7,600');
  assert.equal(s.earnedRetainer_agorot, 600000, '3 months x 2,000 = 6,000');
  assert.equal(s.earned_agorot, 1360000, '13,600 earned in total');
  assert.equal(s.received_agorot, 200000, '2,000 received');
  assert.equal(s.balance_agorot, 1160000, '11,600 NIS outstanding');
});
