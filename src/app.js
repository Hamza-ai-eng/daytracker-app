// app.js — wiring only. All the arithmetic lives in reducer.js, which is tested.

import { reduce, byDate, fmtNis, STREAMS, DataError } from './reducer.js';
import { append, buildDoc, count, newId, nowStamp, today, replaceAll } from './store.js';
import { KEYS } from './config.js';
import { push, pull, pushSoon, verifyArchive, isConfigured, lastSyncText, get, set, owner } from './sync.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

let state = null;
let index = new Map();
let viewMonth = today().slice(0, 7);
let sheetDate = null;
let sheetDraft = null;

// ── boot ─────────────────────────────────────────────────────────────────────

async function refresh() {
  try {
    const doc = await buildDoc();
    state = reduce(doc);
    index = byDate(state);
    renderAll();
  } catch (e) {
    // Loud failure. Never a blank screen implying zero days worked.
    document.body.innerHTML =
      '<div style="padding:24px;font:16px/1.6 system-ui;color:#d4693f">' +
      '<h2 style="margin:0 0 8px">The saved data could not be read</h2>' +
      '<p style="color:#a2988e">Nothing has been changed or deleted. The record is still on this phone and in the archive.</p>' +
      '<pre style="white-space:pre-wrap;background:#00000022;padding:12px;border-radius:8px">' +
      String(e && e.message ? e.message : e) +
      '</pre></div>';
    throw e;
  }
}

async function addEvent(ev, reason) {
  await append(ev);
  await refresh();
  // Immediately, never on a timer — MIUI may kill the app before a timer fires.
  pushSoon(reason, () => renderSync());
  renderSync();
}

// ── header ───────────────────────────────────────────────────────────────────

function renderHeader() {
  $('bal').textContent = fmtNis(state.balance_agorot);
  $('balLabel').textContent = state.balance_agorot < 0 ? 'Overpaid' : 'Outstanding';
  $('earned').textContent = fmtNis(state.earned_agorot);
  $('received').textContent = fmtNis(state.received_agorot);
}

function renderSync() {
  const s = lastSyncText();
  $('syncText').textContent = s.text;
  $('sync').classList.toggle('bad', s.bad);
}

// ── days ─────────────────────────────────────────────────────────────────────

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function shiftMonth(ym, delta) {
  let [y, m] = ym.split('-').map(Number);
  m += delta;
  while (m < 1) { m += 12; y -= 1; }
  while (m > 12) { m -= 12; y += 1; }
  return y + '-' + String(m).padStart(2, '0');
}

function renderGrid() {
  const [y, m] = viewMonth.split('-').map(Number);
  $('mTitle').textContent = MONTHS[m - 1] + ' ' + y;

  const grid = $('grid');
  grid.textContent = '';

  const first = new Date(y, m - 1, 1);
  const lead = (first.getDay() + 6) % 7; // Monday-first
  const dim = new Date(y, m, 0).getDate();
  const td = today();

  for (let i = 0; i < lead; i++) grid.appendChild(el('div', 'cell pad'));

  for (let d = 1; d <= dim; d++) {
    const date = viewMonth + '-' + String(d).padStart(2, '0');
    const rec = index.get(date);
    const cell = el('div', 'cell');
    cell.dataset.date = date;
    if (rec) cell.classList.add(rec.portion);
    if (date === td) cell.classList.add('today');
    if (date > td) cell.classList.add('future');

    cell.appendChild(el('div', 'd', String(d)));

    const tag = el('div', 'tag');
    if (rec) {
      for (const s of rec.streams) tag.appendChild(el('i', s === 'ops' ? 'ops' : 'camp'));
    }
    cell.appendChild(tag);

    if (rec && rec.note) cell.appendChild(el('div', 'note', '•'));

    attachCell(cell, date);
    grid.appendChild(cell);
  }

  const mm = state.months.find((x) => x.month === viewMonth);
  $('mDays').textContent = mm ? mm.days : 0;
  $('mFH').textContent = mm ? mm.full + ' / ' + mm.half : '0 / 0';
  $('mStreams').textContent = mm ? mm.byStream.ops + ' / ' + mm.byStream.campaign : '0 / 0';
  $('mEarned').textContent = (mm ? fmtNis(mm.earned_agorot) : '0') + ' NIS';
}

/** Tap cycles full → half → clear. Press-and-hold opens the detail sheet. */
function attachCell(cell, date) {
  let timer = null;
  let held = false;

  const start = () => {
    held = false;
    timer = setTimeout(() => {
      held = true;
      if (navigator.vibrate) navigator.vibrate(12);
      openSheet(date);
    }, 500);
  };
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  cell.addEventListener('pointerdown', start);
  cell.addEventListener('pointerup', cancel);
  cell.addEventListener('pointerleave', cancel);
  cell.addEventListener('pointercancel', cancel);
  cell.addEventListener('contextmenu', (e) => e.preventDefault());
  cell.addEventListener('click', () => {
    if (held) { held = false; return; }
    cycleDay(date);
  });
}

function lastStreams() {
  const raw = get(KEYS.lastStreams);
  const arr = raw ? raw.split(',').filter((s) => STREAMS.includes(s)) : [];
  return arr.length ? arr : ['ops'];
}

async function cycleDay(date) {
  const rec = index.get(date);
  const next = !rec ? 'full' : rec.portion === 'full' ? 'half' : 'none';

  if (next === 'none') {
    await addEvent(
      { id: newId(), type: 'day', date, recorded_at: nowStamp(), worked: false },
      'clear ' + date
    );
    return;
  }
  await addEvent(
    {
      id: newId(),
      type: 'day',
      date,
      recorded_at: nowStamp(),
      worked: true,
      portion: next,
      streams: rec ? rec.streams : lastStreams(),
      note: rec ? rec.note : '',
    },
    next + ' day ' + date
  );
}

// ── day sheet ────────────────────────────────────────────────────────────────

function openSheet(date) {
  sheetDate = date;
  const rec = index.get(date);
  sheetDraft = {
    portion: rec ? rec.portion : 'full',
    streams: rec ? [...rec.streams] : lastStreams(),
    note: rec ? rec.note : '',
  };

  const d = new Date(date + 'T12:00:00');
  $('dsTitle').textContent = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  $('dsSub').textContent = rec
    ? rec.logged_after_days > 0
      ? 'Logged ' + rec.logged_after_days + ' day' + (rec.logged_after_days === 1 ? '' : 's') + ' later'
      : 'Logged the same day'
    : 'Not logged yet';
  $('dsNote').value = sheetDraft.note;
  paintSheet();
  $('scrim').classList.add('on');
  $('daySheet').classList.add('on');
}

function paintSheet() {
  document.querySelectorAll('[data-portion]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.portion === sheetDraft.portion));
  });
  document.querySelectorAll('[data-stream]').forEach((b) => {
    b.setAttribute('aria-pressed', String(sheetDraft.streams.includes(b.dataset.stream)));
  });
}

function closeSheet() {
  $('scrim').classList.remove('on');
  $('daySheet').classList.remove('on');
  sheetDate = null;
}

async function saveSheet() {
  const date = sheetDate;
  const draft = sheetDraft;
  closeSheet();
  if (!date) return;

  if (draft.portion === 'none') {
    await addEvent({ id: newId(), type: 'day', date, recorded_at: nowStamp(), worked: false }, 'clear ' + date);
    return;
  }
  if (!draft.streams.length) draft.streams = ['ops'];
  set(KEYS.lastStreams, draft.streams.join(','));

  await addEvent(
    {
      id: newId(),
      type: 'day',
      date,
      recorded_at: nowStamp(),
      worked: true,
      portion: draft.portion,
      streams: draft.streams,
      note: draft.note,
    },
    'edit ' + date
  );
}

// ── payments ─────────────────────────────────────────────────────────────────

function renderPayments() {
  const list = $('plist');
  list.textContent = '';
  if (!state.payments.length) {
    list.appendChild(el('div', 'empty', 'No payments recorded yet.'));
    return;
  }
  for (const p of state.payments) {
    const row = el('div', 'prow');
    const left = el('div');
    left.appendChild(el('div', 'amt', fmtNis(p.amount_agorot) + ' NIS'));
    const bits = [p.date];
    if (p.method) bits.push(p.method);
    if (p.note) bits.push(p.note);
    left.appendChild(el('div', 'meta', bits.join(' · ')));
    row.appendChild(left);

    const del = el('button', null, '×');
    del.setAttribute('aria-label', 'Delete payment');
    del.addEventListener('click', async () => {
      if (!confirm('Remove this payment of ' + fmtNis(p.amount_agorot) + ' NIS?')) return;
      await addEvent(
        { id: newId(), type: 'payment', ref: p.ref, deleted: true, recorded_at: nowStamp() },
        'delete payment'
      );
    });
    row.appendChild(del);
    list.appendChild(row);
  }
}

async function addPayment() {
  const nis = parseFloat($('pAmt').value);
  if (!Number.isFinite(nis) || nis <= 0) { alert('Enter an amount.'); return; }
  const date = $('pDate').value || today();
  const agorot = Math.round(nis * 100);

  await addEvent(
    {
      id: newId(),
      type: 'payment',
      date,
      recorded_at: nowStamp(),
      amount_agorot: agorot,
      method: $('pMethod').value,
      note: $('pNote').value.trim(),
    },
    'payment ' + fmtNis(agorot)
  );
  $('pAmt').value = '';
  $('pNote').value = '';
  $('pDate').value = today();
}

// ── setup ────────────────────────────────────────────────────────────────────

async function renderSetup() {
  $('sOwner').value = owner() === 'CHANGE_ME' ? '' : owner();
  $('sToken').value = get(KEYS.token);
  $('sPass').value = get(KEYS.passphrase);
  $('sRate').value = state.currentRate ? state.currentRate / 100 : 400;

  $('stEvents').textContent = await count();
  $('stSync').textContent = lastSyncText().text;
  $('stRate').textContent = state.currentRate ? fmtNis(state.currentRate) + ' NIS/day' : 'not set';

  const warn = $('setupWarn');
  warn.textContent = '';
  if (!isConfigured()) {
    const w = el('div', 'warn', 'This phone is the only copy right now. Fill these in so the record is backed up.');
    warn.appendChild(w);
  }

  if (navigator.storage && navigator.storage.persisted) {
    const p = await navigator.storage.persisted();
    $('stPersist').textContent = p ? 'yes' : 'no — sync is what protects you';
  } else {
    $('stPersist').textContent = 'unknown';
  }
}

async function saveSetup() {
  set(KEYS.owner, $('sOwner').value.trim());
  set(KEYS.token, $('sToken').value.trim());
  set(KEYS.passphrase, $('sPass').value);
  set(KEYS.syncError, '');
  if (!isConfigured()) { alert('Fill in all three fields.'); return; }
  await doSync('setup');
}

async function doSync(reason) {
  const btn = $('sSave');
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  try {
    const r = await push(reason);
    alert(r.pushed ? 'Synced. ' + r.events + ' events in the archive.' : 'Already up to date. ' + r.events + ' events.');
    await refresh();
  } catch (e) {
    alert('Sync failed.\n\n' + (e && e.message ? e.message : e));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save & sync now';
    renderSync();
    renderSetup();
  }
}

async function setRate() {
  const nis = parseFloat($('sRate').value);
  if (!Number.isFinite(nis) || nis <= 0) { alert('Enter a rate.'); return; }
  const agorot = Math.round(nis * 100);
  if (state.currentRate === agorot) { alert('That is already the current rate.'); return; }
  if (!confirm('Set ' + fmtNis(agorot) + ' NIS/day from today onward?\n\nPast days keep the rate they were earned at.')) return;
  await addEvent(
    { id: newId(), type: 'rate_set', effective_from: today(), rate_agorot: agorot, recorded_at: nowStamp() },
    'rate ' + fmtNis(agorot)
  );
  renderSetup();
}

function download(name, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function exportCsv() {
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

  // BOM so Excel opens UTF-8 correctly.
  const csv = '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  download('daytracker-' + today() + '.csv', csv, 'text/csv;charset=utf-8');
}

async function exportJson() {
  const doc = await buildDoc();
  download('daytracker-' + today() + '.json', JSON.stringify(doc, null, 2), 'application/json');
}

async function checkBackup() {
  const box = $('checkOut');
  const btn = $('sCheck');
  box.hidden = false;
  box.className = 'v';
  box.textContent = 'Checking...';
  btn.disabled = true;
  try {
    const r = await verifyArchive();
    const st = reduce(r.doc);
    const NL = String.fromCharCode(10);
    box.className = 'v ' + (r.complete ? 'ok' : 'err');
    box.textContent = [
      r.complete
        ? 'OK - your backup is safe.'
        : r.missing + ' entries are NOT backed up yet.',
      '',
      'It opened with your passphrase, so it can be restored.',
      '',
      'In the backup:',
      '  ' + st.days.length + ' days worked',
      '  ' + st.payments.length + ' payments',
      '  ' + fmtNis(st.balance_agorot) + ' NIS outstanding',
    ].concat(
      r.complete ? [] : ['', 'Press "Save & sync now" above, then check again.']
    ).join(NL);
  } catch (e) {
    box.className = 'v err';
    box.textContent = 'Could not read the backup.' + String.fromCharCode(10, 10) +
      (e && e.message ? e.message : e);
  } finally {
    btn.disabled = false;
  }
}

async function restore() {
  if (!confirm('Pull the archive from GitHub and REPLACE everything on this phone?\n\nUse this after reinstalling, or as the quarterly drill.')) return;
  try {
    const n = await pull();
    await refresh();
    alert('Restored ' + n + ' events from the archive.');
  } catch (e) {
    alert('Restore failed.\n\n' + (e && e.message ? e.message : e));
  }
  renderSetup();
}

// ── tabs / render ────────────────────────────────────────────────────────────

const TABS = [['tab-days', 'v-days'], ['tab-pay', 'v-pay'], ['tab-set', 'v-set']];

function showTab(id) {
  for (const [t, v] of TABS) {
    const on = t === id;
    $(t).setAttribute('aria-selected', String(on));
    $(v).hidden = !on;
  }
  if (id === 'tab-set') renderSetup();
}

function renderAll() {
  renderHeader();
  renderGrid();
  renderPayments();
  renderSync();
}

// ── seed + wire ──────────────────────────────────────────────────────────────

async function seedIfEmpty() {
  if ((await count()) > 0) return;
  await append({
    id: newId(),
    type: 'rate_set',
    effective_from: today(),
    rate_agorot: 40000, // 400 NIS
    recorded_at: nowStamp(),
  });
}

function wire() {
  for (const [t] of TABS) $(t).addEventListener('click', () => showTab(t));

  $('prevM').addEventListener('click', () => { viewMonth = shiftMonth(viewMonth, -1); renderGrid(); });
  $('nextM').addEventListener('click', () => { viewMonth = shiftMonth(viewMonth, 1); renderGrid(); });

  document.querySelectorAll('[data-portion]').forEach((b) =>
    b.addEventListener('click', () => { sheetDraft.portion = b.dataset.portion; paintSheet(); })
  );
  document.querySelectorAll('[data-stream]').forEach((b) =>
    b.addEventListener('click', () => {
      const s = b.dataset.stream;
      const i = sheetDraft.streams.indexOf(s);
      if (i >= 0) sheetDraft.streams.splice(i, 1); else sheetDraft.streams.push(s);
      paintSheet();
    })
  );
  $('dsNote').addEventListener('input', (e) => { sheetDraft.note = e.target.value; });
  $('dsSave').addEventListener('click', saveSheet);
  $('dsCancel').addEventListener('click', closeSheet);
  $('scrim').addEventListener('click', closeSheet);

  $('pAdd').addEventListener('click', addPayment);
  $('sSave').addEventListener('click', saveSetup);
  $('sTest').addEventListener('click', () => doSync('test'));
  $('sRateSave').addEventListener('click', setRate);
  $('sExport').addEventListener('click', exportCsv);
  $('sJson').addEventListener('click', exportJson);
  $('sCheck').addEventListener('click', checkBackup);
  $('sRestore').addEventListener('click', restore);

  // Coming back to the app is a good moment to catch up on a failed sync.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && isConfigured()) pushSoon('resume', () => renderSync());
  });
  window.addEventListener('online', () => { if (isConfigured()) pushSoon('online', () => renderSync()); });

  $('pDate').value = today();
}

async function main() {
  wire();
  await seedIfEmpty();
  await refresh();

  // Ask for protected storage. Chrome grants it on engagement, not on install,
  // so this usually says no at first. The answer is surfaced in Setup either way.
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persisted().then((p) => { if (!p) navigator.storage.persist(); });
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // Launched from the long-press shortcut: log today straight away.
  if (new URLSearchParams(location.search).get('action') === 'today') {
    history.replaceState(null, '', location.pathname);
    if (!index.get(today())) cycleDay(today());
  }

  if (isConfigured()) pushSoon('open', () => renderSync());
}

main();
