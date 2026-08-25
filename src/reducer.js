// reducer.js — events in, derived state out.
//
// PURE. No DOM, no browser APIs, no I/O. Imported unchanged by the browser and by
// `node --test`. That is the entire reason it stays pure.
//
// Money is handled in AGOROT (integer) throughout. Floats are never summed.

export const SCHEMA_VERSION = 1;

// A worked day is worth this many halves of the day rate.
export const PORTION_FACTOR = { full: 2, half: 1 };
const PORTION_DIVISOR = 2;

export const STREAMS = ['ops', 'campaign'];

export class DataError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'DataError';
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isStamp = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/**
 * Validate the document shape. Throws loudly rather than returning zeros.
 *
 * This exists because of the Mission Control schema-drift bug: the server sent
 * status:'online', the client read service.online, and every service showed offline
 * forever because undefined renders as "off". A silent undefined here would render
 * as "no days worked" and quietly understate what he is owed.
 */
export function validate(doc) {
  if (!isObj(doc)) throw new DataError('Document is not an object');
  if (doc.version !== SCHEMA_VERSION) {
    throw new DataError(
      'Unsupported schema version: ' + JSON.stringify(doc.version) + ' (expected ' + SCHEMA_VERSION + ')'
    );
  }
  if (!Array.isArray(doc.events)) throw new DataError('Document.events is not an array');

  doc.events.forEach((e, i) => {
    const at = 'events[' + i + ']';
    if (!isObj(e)) throw new DataError(at + ' is not an object');
    if (typeof e.id !== 'string' || !e.id) throw new DataError(at + '.id missing');
    if (!isStamp(e.recorded_at)) throw new DataError(at + '.recorded_at is not a valid timestamp');

    switch (e.type) {
      case 'day': {
        if (!isDate(e.date)) throw new DataError(at + '.date must be YYYY-MM-DD');
        if (e.deleted === true) break;
        if (typeof e.worked !== 'boolean') throw new DataError(at + '.worked must be boolean');
        if (e.worked) {
          if (!(e.portion in PORTION_FACTOR)) {
            throw new DataError(at + ".portion must be 'full' or 'half'");
          }
          if (!Array.isArray(e.streams) || e.streams.length === 0) {
            throw new DataError(at + '.streams must be a non-empty array');
          }
          for (const s of e.streams) {
            if (!STREAMS.includes(s)) {
              throw new DataError(at + ".streams contains unknown stream '" + s + "'");
            }
          }
        }
        break;
      }
      case 'payment': {
        if (e.deleted === true) break;
        if (!isDate(e.date)) throw new DataError(at + '.date must be YYYY-MM-DD');
        if (!Number.isInteger(e.amount_agorot)) {
          throw new DataError(at + '.amount_agorot must be an integer');
        }
        if (e.amount_agorot <= 0) throw new DataError(at + '.amount_agorot must be positive');
        break;
      }
      case 'rate_set': {
        if (!isDate(e.effective_from)) throw new DataError(at + '.effective_from must be YYYY-MM-DD');
        if (!Number.isInteger(e.rate_agorot) || e.rate_agorot <= 0) {
          throw new DataError(at + '.rate_agorot must be a positive integer');
        }
        break;
      }
      default:
        throw new DataError(at + '.type is unknown: ' + JSON.stringify(e.type));
    }
  });

  return true;
}

// Latest wins. Ties on recorded_at fall back to document order, so replay is deterministic.
function latest(a, b) {
  const ta = Date.parse(a.e.recorded_at);
  const tb = Date.parse(b.e.recorded_at);
  if (ta !== tb) return ta > tb ? a : b;
  return b.i > a.i ? b : a;
}

/** Whole days between the day worked and the calendar day it was actually entered. */
export function loggedAfterDays(date, recorded_at) {
  const d = Date.parse(date + 'T00:00:00Z');
  const r = Date.parse(recorded_at);
  if (Number.isNaN(d) || Number.isNaN(r)) return null;
  const rDay = Date.parse(new Date(r).toISOString().slice(0, 10) + 'T00:00:00Z');
  return Math.round((rDay - d) / 86400000);
}

/**
 * Rate in force on a given date.
 * Days that predate every rate_set use the earliest rate — documented behaviour,
 * chosen over throwing so that a backfilled day can never be un-priceable.
 */
export function rateOn(rates, date) {
  if (rates.length === 0) throw new DataError('No rate has ever been set');
  let chosen = rates[0];
  for (const r of rates) {
    if (r.effective_from <= date) chosen = r;
    else break;
  }
  return chosen.rate_agorot;
}

export function reduce(doc) {
  validate(doc);

  const dayPick = new Map(); // date -> {e, i}
  const payPick = new Map(); // ref  -> {e, i}
  const rates = [];

  doc.events.forEach((e, i) => {
    if (e.type === 'day') {
      const prev = dayPick.get(e.date);
      dayPick.set(e.date, prev ? latest(prev, { e, i }) : { e, i });
    } else if (e.type === 'payment') {
      const ref = e.ref || e.id; // a correction reuses the original payment's id
      const prev = payPick.get(ref);
      payPick.set(ref, prev ? latest(prev, { e, i }) : { e, i });
    } else if (e.type === 'rate_set') {
      rates.push(e);
    }
  });

  rates.sort((a, b) => {
    if (a.effective_from < b.effective_from) return -1;
    if (a.effective_from > b.effective_from) return 1;
    return Date.parse(a.recorded_at) - Date.parse(b.recorded_at);
  });

  const days = [];
  for (const { e } of dayPick.values()) {
    if (e.deleted === true || e.worked === false) continue;
    const rate = rateOn(rates, e.date);
    // Integer maths: floor((rate * halves) / 2). Exact for full days and for even
    // rates; an odd-agorot half day rounds down, by design and never silently.
    const value = Math.floor((rate * PORTION_FACTOR[e.portion]) / PORTION_DIVISOR);
    days.push({
      date: e.date,
      portion: e.portion,
      streams: [...e.streams].sort(),
      note: e.note || '',
      recorded_at: e.recorded_at,
      logged_after_days: loggedAfterDays(e.date, e.recorded_at),
      rate_agorot: rate,
      value_agorot: value,
    });
  }
  days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const payments = [];
  for (const [ref, { e }] of payPick.entries()) {
    if (e.deleted === true) continue;
    payments.push({
      ref,
      date: e.date,
      amount_agorot: e.amount_agorot,
      method: e.method || '',
      note: e.note || '',
      recorded_at: e.recorded_at,
    });
  }
  payments.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // newest first

  const earned_agorot = days.reduce((s, d) => s + d.value_agorot, 0);
  const received_agorot = payments.reduce((s, p) => s + p.amount_agorot, 0);

  // Per-month rollup. A day tagged with both streams still counts as ONE day and is
  // priced once; the stream buckets only record which kinds of work it touched.
  const months = {};
  for (const d of days) {
    const m = d.date.slice(0, 7);
    if (!months[m]) {
      months[m] = {
        month: m,
        days: 0,
        full: 0,
        half: 0,
        earned_agorot: 0,
        byStream: Object.fromEntries(STREAMS.map((s) => [s, 0])),
      };
    }
    const bucket = months[m];
    bucket.days += 1;
    bucket[d.portion] += 1;
    bucket.earned_agorot += d.value_agorot;
    for (const s of d.streams) bucket.byStream[s] += 1;
  }

  return {
    days,
    payments,
    rates: rates.map((r) => ({ effective_from: r.effective_from, rate_agorot: r.rate_agorot })),
    currentRate: rates.length ? rates[rates.length - 1].rate_agorot : null,
    earned_agorot,
    received_agorot,
    balance_agorot: earned_agorot - received_agorot,
    months: Object.values(months).sort((a, b) => (a.month < b.month ? 1 : -1)),
  };
}

/** Index days by date for O(1) lookup from the calendar grid. */
export function byDate(state) {
  const m = new Map();
  for (const d of state.days) m.set(d.date, d);
  return m;
}

export const toNis = (agorot) => agorot / 100;

export function fmtNis(agorot) {
  const neg = agorot < 0;
  const abs = Math.abs(agorot);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  const s = whole.toLocaleString('en-US') + (frac ? '.' + String(frac).padStart(2, '0') : '');
  return (neg ? '-' : '') + s;
}
