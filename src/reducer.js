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
const isMonth = (v) => typeof v === 'string' && /^\d{4}-\d{2}$/.test(v);

/** Walk forward one calendar month. '2026-12' -> '2027-01'. */
export function nextMonth(ym) {
  let [y, m] = ym.split('-').map(Number);
  m += 1;
  if (m > 12) { m = 1; y += 1; }
  return y + '-' + String(m).padStart(2, '0');
}

/**
 * Which months a monthly retainer is charged for, and how much each time.
 *
 * The rule, stated once so it is never ambiguous: a retainer is charged on the
 * FIRST of each month, for every month from the one it starts in up to and
 * including the month of `asOfMonth`. Setting the amount to 0 stops it from that
 * month onward. Retainers are billed for the period ahead, which is why the
 * current month counts as soon as it begins.
 */
export function retainerCharges(retainerEvents, asOfMonth) {
  if (!retainerEvents.length || !isMonth(asOfMonth)) return [];

  const byMonth = new Map();
  for (const e of retainerEvents) {
    const prev = byMonth.get(e.from_month);
    if (!prev || Date.parse(e.recorded_at) >= Date.parse(prev.recorded_at)) byMonth.set(e.from_month, e);
  }
  const changes = [...byMonth.values()].sort((a, b) => (a.from_month < b.from_month ? -1 : 1));

  const out = [];
  let m = changes[0].from_month;
  let amount = 0;
  let i = 0;

  while (m <= asOfMonth) {
    while (i < changes.length && changes[i].from_month <= m) {
      amount = changes[i].amount_agorot;
      i += 1;
    }
    if (amount > 0) out.push({ month: m, amount_agorot: amount });
    m = nextMonth(m);
  }
  return out;
}
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
      case 'retainer_set': {
        // A flat monthly fee, independent of days worked. Zero ends it.
        if (!isMonth(e.from_month)) throw new DataError(at + '.from_month must be YYYY-MM');
        if (!Number.isInteger(e.amount_agorot) || e.amount_agorot < 0) {
          throw new DataError(at + '.amount_agorot must be a non-negative integer');
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

/**
 * @param doc   the event log
 * @param asOf  YYYY-MM-DD, the day the books are being read on. Passed in rather
 *              than read from the clock so this stays pure and testable. Defaults
 *              to the latest date the log itself knows about.
 */
export function reduce(doc, asOf) {
  validate(doc);

  const dayPick = new Map(); // date -> {e, i}
  const payPick = new Map(); // ref  -> {e, i}
  const rates = [];
  const retainers = [];

  doc.events.forEach((e, i) => {
    if (e.type === 'retainer_set') retainers.push(e);
  });

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

  const earnedDays_agorot = days.reduce((s, d) => s + d.value_agorot, 0);
  const received_agorot = payments.reduce((s, p) => s + p.amount_agorot, 0);

  // As-of date: given, else the latest thing the log knows about. Never the clock —
  // reduce() must give the same answer for the same input, forever.
  let effectiveAsOf = asOf;
  if (!isDate(effectiveAsOf)) {
    let latest = '0000-00-00';
    for (const e of doc.events) {
      if (e.date && e.date > latest) latest = e.date;
      const rec = String(e.recorded_at || '').slice(0, 10);
      if (isDate(rec) && rec > latest) latest = rec;
    }
    effectiveAsOf = latest === '0000-00-00' ? null : latest;
  }

  const charges = effectiveAsOf ? retainerCharges(retainers, effectiveAsOf.slice(0, 7)) : [];
  const earnedRetainer_agorot = charges.reduce((s, c) => s + c.amount_agorot, 0);
  const earned_agorot = earnedDays_agorot + earnedRetainer_agorot;

  const currentRetainer = (() => {
    if (!charges.length) return 0;
    return charges[charges.length - 1].amount_agorot;
  })();

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
        days_agorot: 0,
        retainer_agorot: 0,
        byStream: Object.fromEntries(STREAMS.map((s) => [s, 0])),
      };
    }
    const bucket = months[m];
    bucket.days += 1;
    bucket[d.portion] += 1;
    bucket.earned_agorot += d.value_agorot;
    bucket.days_agorot += d.value_agorot;
    for (const s of d.streams) bucket.byStream[s] += 1;
  }

  // Retainer months appear in the rollup even when no day was worked in them.
  for (const c of charges) {
    if (!months[c.month]) {
      months[c.month] = {
        month: c.month, days: 0, full: 0, half: 0,
        earned_agorot: 0, days_agorot: 0, retainer_agorot: 0,
        byStream: Object.fromEntries(STREAMS.map((s) => [s, 0])),
      };
    }
    months[c.month].retainer_agorot += c.amount_agorot;
    months[c.month].earned_agorot += c.amount_agorot;
  }

  return {
    days,
    payments,
    rates: rates.map((r) => ({ effective_from: r.effective_from, rate_agorot: r.rate_agorot })),
    currentRate: rates.length ? rates[rates.length - 1].rate_agorot : null,
    retainerCharges: charges,
    currentRetainer,
    asOf: effectiveAsOf,
    earnedDays_agorot,
    earnedRetainer_agorot,
    earned_agorot,
    received_agorot,
    balance_agorot: earned_agorot - received_agorot,
    months: Object.values(months).sort((a, b) => (a.month < b.month ? 1 : -1)),
  };
}

/**
 * Every date in [from, to] falling on one of the given weekdays (0 = Sunday).
 *
 * Pure and tested because it is used to write a stretch of real days into the
 * record in one go — a fencepost error here would silently add or drop a paid day.
 * Dates are built from calendar parts, never from UTC, so no timezone can shift one.
 */
export function datesInRange(from, to, weekdays) {
  if (!isDate(from) || !isDate(to)) throw new DataError('Dates must be YYYY-MM-DD');
  const want = new Set(weekdays || []);
  if (!want.size) return [];
  if (from > to) return [];

  const pad = (n) => String(n).padStart(2, '0');
  const [fy, fm, fd] = from.split('-').map(Number);
  const cur = new Date(fy, fm - 1, fd);
  const out = [];

  // Guard against a runaway loop if someone types the year 9999.
  for (let i = 0; i < 20000; i++) {
    const iso = cur.getFullYear() + '-' + pad(cur.getMonth() + 1) + '-' + pad(cur.getDate());
    if (iso > to) break;
    if (want.has(cur.getDay())) out.push(iso);
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

/**
 * Parse a typed or pasted list of dates. Accepts YYYY-MM-DD or DD/MM/YYYY,
 * separated by commas, spaces or new lines.
 *
 * Returns { dates, bad } rather than throwing, so the UI can show exactly which
 * entry was not understood instead of silently dropping a day someone worked.
 */
export function parseDateList(text) {
  const dates = [];
  const bad = [];
  const seen = new Set();

  for (const raw of String(text || '').split(/[\s,;]+/)) {
    const tok = raw.trim();
    if (!tok) continue;

    let iso = null;
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(tok)) {
      const [y, m, d] = tok.split('-').map(Number);
      iso = y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    } else if (/^\d{1,2}[/.]\d{1,2}[/.]\d{4}$/.test(tok)) {
      const [d, m, y] = tok.split(/[/.]/).map(Number);
      iso = y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    }

    // Reject dates that look right but do not exist, e.g. 2026-02-31.
    if (iso) {
      const [y, m, d] = iso.split('-').map(Number);
      const probe = new Date(y, m - 1, d);
      if (probe.getFullYear() !== y || probe.getMonth() !== m - 1 || probe.getDate() !== d) iso = null;
    }

    if (!iso) bad.push(tok);
    else if (!seen.has(iso)) {
      seen.add(iso);
      dates.push(iso);
    }
  }

  dates.sort();
  return { dates, bad };
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
