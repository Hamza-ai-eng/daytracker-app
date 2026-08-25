// Extracted from phase0.html so the page can run under a strict CSP
// (script-src 'self' blocks inline scripts, which is the point of it).

const out = document.getElementById('out');
const results = [];

function card(id, title, why, verdict, detail, gate) {
  results.push({ id, title, verdict, detail: String(detail) });
  const d = document.createElement('div');
  d.className = 't' + (gate ? ' gate' : '');
  const cls = verdict === 'PASS' ? 'pass' : verdict === 'FAIL' ? 'fail' : 'info';
  d.innerHTML =
    '<h3>' + id + ' — ' + title + ' <span class="badge ' + cls + '">' + verdict + '</span>' +
    (gate ? ' <span class="badge run">GATE</span>' : '') + '</h3>' +
    '<p class="why">' + why + '</p><div class="v"></div>';
  d.querySelector('.v').textContent = detail;
  out.appendChild(d);
}

function summarise() {
  const gates = results.filter((r) => r.gate);
  const fails = results.filter((r) => r.verdict === 'FAIL');
  document.getElementById('summary').textContent =
    fails.length ? fails.length + ' FAILING — see below' : 'No failures so far';
  document.getElementById('summary').style.color = fails.length ? 'var(--bad)' : 'var(--ok)';
  document.getElementById('report').textContent = results
    .map((r) => '[' + r.verdict + '] ' + r.id + ' ' + r.title + '\n    ' + r.detail.replace(/\n/g, '\n    '))
    .join('\n');
}

// ── 0.1 standalone ───────────────────────────────────────────────────────────
{
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  card('0.1', 'Running as an installed app',
    'If this says browser, install it first: Chrome menu → Add to Home screen, then open it from the icon and reload this page.',
    standalone ? 'PASS' : 'INFO',
    standalone ? 'standalone — launched from the home screen icon' : 'browser tab — not yet installed, or opened from Chrome',
    true);
}

// ── 0.2 service worker / offline ─────────────────────────────────────────────
try {
  let reg = await navigator.serviceWorker.getRegistration();
  if (!reg) reg = await navigator.serviceWorker.register('sw.js');
  await navigator.serviceWorker.ready;
  card('0.2', 'Service worker registered (offline launch)',
    'Without this the app will not open in airplane mode. After it passes: turn on airplane mode, close the app fully, reopen it.',
    'PASS', 'scope ' + reg.scope + '\nstate ' + (reg.active ? reg.active.state : 'installing'), true);
} catch (e) {
  card('0.2', 'Service worker registered (offline launch)',
    'Without this the app will not open in airplane mode.',
    'FAIL', String(e), true);
}

// ── 0.4 persistent storage ───────────────────────────────────────────────────
try {
  const before = await navigator.storage.persisted();
  const granted = before ? true : await navigator.storage.persist();
  const est = await navigator.storage.estimate();
  card('0.4', 'Protected storage',
    'Chrome grants this on engagement, not on install — a "no" here is expected and is exactly why sync exists. Recorded, not gated.',
    granted ? 'PASS' : 'INFO',
    'persisted: ' + granted + '\nbefore asking: ' + before +
    '\nquota: ' + Math.round((est.quota || 0) / 1048576) + ' MB, used: ' + (est.usage || 0) + ' B');
} catch (e) {
  card('0.4', 'Protected storage', 'API unavailable.', 'INFO', String(e));
}

// ── 0.5 real file on phone storage ───────────────────────────────────────────
card('0.5', 'Can a web app write a real file to phone storage?',
  'Expected to be unsupported on Android. If it is, browser storage plus sync is all we get — which is what the design assumes.',
  'INFO',
  'showSaveFilePicker: ' + (typeof window.showSaveFilePicker === 'function' ? 'SUPPORTED' : 'not supported') +
  '\nOPFS: ' + (navigator.storage && navigator.storage.getDirectory ? 'available (still browser-internal)' : 'no'));

// ── 0.9 WebCrypto ────────────────────────────────────────────────────────────
try {
  const m = await import('./crypto.js');
  const doc = { version: 1, events: [{ id: 'x', note: 'عربي ✓ unicode', n: 25075 }] };
  const t0 = performance.now();
  const env = await m.encryptDoc(doc, 'phase-zero');
  const encMs = Math.round(performance.now() - t0);
  const t1 = performance.now();
  const back = await m.decryptDoc(env, 'phase-zero');
  const decMs = Math.round(performance.now() - t1);
  const ok = JSON.stringify(back) === JSON.stringify(doc);
  let rejected = false;
  try { await m.decryptDoc(env, 'wrong'); } catch { rejected = true; }
  card('0.9', 'Encryption round-trip on this device',
    'The archive is useless if this phone cannot encrypt and decrypt it. Timing matters: this runs on every sync.',
    ok && rejected ? 'PASS' : 'FAIL',
    'round trip: ' + ok + '\nwrong passphrase rejected: ' + rejected +
    '\nencrypt: ' + encMs + ' ms\ndecrypt: ' + decMs + ' ms\n(310,000 PBKDF2 iterations)', true);
} catch (e) {
  card('0.9', 'Encryption round-trip on this device', 'WebCrypto failed.', 'FAIL', String(e), true);
}

// ── 0.10 shortcuts + environment ─────────────────────────────────────────────
card('0.10', 'Home-screen quick action',
  'Nice to have, not a gate. Long-press the app icon: a "Log today" entry should appear.',
  'INFO', 'Check by hand on the home screen.');

card('env', 'Device and browser',
  'Recorded so a later failure can be traced to the handset.',
  'INFO',
  navigator.userAgent +
  '\nlanguages: ' + navigator.languages.join(', ') +
  '\nscreen: ' + screen.width + 'x' + screen.height + ' @' + devicePixelRatio +
  '\nindexedDB: ' + (('indexedDB' in window) ? 'yes' : 'NO') +
  '\ncrypto.subtle: ' + ((crypto && crypto.subtle) ? 'yes' : 'NO'));

summarise();

// ── 0.6 / 0.7 GitHub ─────────────────────────────────────────────────────────
const PROBE = '_phase0_probe.txt';
document.getElementById('ghRun').addEventListener('click', async () => {
  const o = document.getElementById('ghOut');
  const owner = document.getElementById('own').value.trim();
  const token = document.getElementById('tok').value.trim();
  if (!owner || !token) { o.textContent = 'Fill in both fields first.'; return; }

  const api = 'https://api.github.com/repos/' + owner + '/daytracker-data/contents/' + PROBE;
  const H = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const log = [];
  const say = (s) => { log.push(s); o.textContent = log.join('\n'); };

  try {
    say('1. reading current probe…');
    let sha = null;
    const g = await fetch(api, { headers: H, cache: 'no-store' });
    if (g.status === 200) { sha = (await g.json()).sha; say('   exists, sha ' + sha.slice(0, 8)); }
    else if (g.status === 404) say('   not there yet (fine)');
    else throw new Error('GET returned ' + g.status + ' — ' + (g.status === 401 ? 'bad token' : g.status === 404 ? 'repo not found or token cannot see it' : 'check token permissions'));

    say('2. writing…');
    const body = { message: 'phase 0 probe', content: btoa('probe ' + new Date().toISOString()) };
    if (sha) body.sha = sha;
    const p = await fetch(api, { method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!p.ok) throw new Error('PUT returned ' + p.status + ' — token likely lacks Contents: write');
    const newSha = (await p.json()).content.sha;
    say('   WROTE OK — 0.6 PASS (commit ' + newSha.slice(0, 8) + ')');

    say('3. forcing a stale-sha conflict…');
    const stale = await fetch(api, { method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'stale', content: btoa('stale'), sha: sha || newSha }) });
    if (stale.ok && sha) { say('   UNEXPECTED: stale write accepted — investigate'); }
    else say('   rejected with ' + stale.status + ' as it should be');

    say('4. re-reading and retrying…');
    const g2 = await fetch(api, { headers: H, cache: 'no-store' });
    const sha2 = (await g2.json()).sha;
    const r = await fetch(api, { method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'phase 0 retry', content: btoa('retry ' + Date.now()), sha: sha2 }) });
    say(r.ok ? '   RECOVERED — 0.7 PASS' : '   retry failed with ' + r.status + ' — 0.7 FAIL');

    results.push({ id: '0.6/0.7', title: 'GitHub write + conflict recovery', verdict: r.ok ? 'PASS' : 'FAIL', detail: log.join('\n') });
    summarise();
  } catch (e) {
    say('FAILED: ' + e.message);
    results.push({ id: '0.6/0.7', title: 'GitHub write + conflict recovery', verdict: 'FAIL', detail: log.join('\n') });
    summarise();
  }
});

// ── 0.3 MIUI marker ──────────────────────────────────────────────────────────
const MK = 'dt_phase0_marker';
document.getElementById('markSet').addEventListener('click', async () => {
  const stamp = new Date().toISOString();
  localStorage.setItem(MK, stamp);
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('dt_phase0', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('m');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  await new Promise((res) => {
    const t = db.transaction('m', 'readwrite');
    t.objectStore('m').put(stamp, 'set');
    t.oncomplete = res;
  });
  document.getElementById('markOut').textContent =
    'Marker set at ' + stamp +
    '\n\nNow: Security app → Cleaner → run it. Then restart the phone. Then come back and press 2.';
});

document.getElementById('markCheck').addEventListener('click', async () => {
  const ls = localStorage.getItem(MK);
  let idb = null;
  try {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('dt_phase0', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('m');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    idb = await new Promise((res) => {
      const t = db.transaction('m', 'readonly').objectStore('m').get('set');
      t.onsuccess = () => res(t.result || null);
      t.onerror = () => res(null);
    });
  } catch (e) { idb = 'error: ' + e; }

  const survived = Boolean(ls && idb);
  const text =
    'localStorage: ' + (ls || 'GONE') + '\nIndexedDB:    ' + (idb || 'GONE') + '\n\n' +
    (survived
      ? 'SURVIVED — MIUI did not wipe browser storage.'
      : 'WIPED — this is the most important finding of Phase 0. Sync on every write is what saves the record; never rely on the phone alone.');
  document.getElementById('markOut').textContent = text;
  results.push({ id: '0.3', title: 'MIUI cleaner survival', verdict: survived ? 'PASS' : 'FAIL', detail: text });
  summarise();
});

document.getElementById('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(document.getElementById('report').textContent); alert('Copied.'); }
  catch { alert('Select the text and copy it by hand.'); }
});
