# DayTracker

Working days and payments for AlDay3a. One tap logs a day; the balance on screen is what
is still owed at 400 NIS/day.

This is **not** the killed `tapsapps.com` ordering app. Different thing, private, mine only.

---

## The one idea

**The phone is a capture device. It is never the archive.**

```
  PHONE (primary)               GITHUB (archive)            LAPTOP (cold copy)
  Installed PWA           ──▶   daytracker-data (private)   C:\Home\Finance\daytracker\
  IndexedDB event log           days.enc.json               node tools/pull.mjs
  Works in airplane mode        AES-GCM ciphertext          read-only, never writes
  Encrypts before sending       every save is a commit      → external drive backup
```

Three copies. For the record to be lost, all three have to fail independently.

**What the encryption buys, and what it does not.** It protects the copy at GitHub — they
store a file they cannot read. The phone's own copy is plaintext in IndexedDB, because
encrypting that too would mean typing a passphrase on every open, which kills the one-tap
goal. Safe against GitHub, the network and a leaked repo. Not a defence against someone
holding the unlocked phone.

---

## Constraints this was built under

- **Zero dependencies. No framework, no bundler, no `npm install`.** Plain ES modules,
  WebCrypto for encryption, `node:test` for tests. A day log that needs a toolchain to run
  in 2030 is a day log that is gone in 2030.
- **Append-only.** Nothing is ever overwritten. A correction is a new event that supersedes
  the old one; both stay in the file.
- **Bad data fails loudly.** The document carries a `version`, validated on load. It throws
  rather than rendering `undefined` as "no days worked" and quietly understating the total.
- **One writer.** The phone writes, the laptop pulls. Every push still merges by event id as
  a safety net, so nothing is discarded even if that rule is ever broken.

---

## Setup, once

**1. Two repos.**

| Repo | Visibility | Holds |
|---|---|---|
| `daytracker-app` | public | this code. No secrets — the token is typed on the phone, never committed. |
| `daytracker-data` | **private** | `days.enc.json`, the encrypted record. |

Separate because Pages on a private repo needs Pro and serves publicly anyway.

**2. Serve the app.** Push `src/` to `daytracker-app`, then Settings → Pages → deploy from
branch, root. It becomes `https://<username>.github.io/daytracker-app/`. Vercel works too.

**3. Make the token.** GitHub → Settings → Developer settings → Personal access tokens →
**Fine-grained tokens**:

- Repository access: **only `daytracker-data`**
- Permissions → Repository permissions → **Contents: Read and write**
- Set an expiry date, and **write that date down** — the app will start failing loudly when
  it lapses, but knowing in advance is better.

**4. Pick a passphrase and write it on paper.** Lose it and the GitHub archive can never be
read again. The phone's copy survives, but the backup does not.

**5. On the phone.** Open the Pages URL in Chrome → menu → Add to Home screen. Open it from
the icon. Setup tab → username, token, passphrase → **Save & sync now**.

**6. Laptop.** `cp .env.example .env`, fill it in with a **read-only** token, then:

```bash
node tools/pull.mjs
```

Writes `daytracker.json` and a dated CSV into `C:\Home\Finance\daytracker\`.

---

## Using it

**Days tab.** Tap a day to cycle: full → half → clear. Today is pre-highlighted, but
backfilling is the normal path, not a special case — press and hold any day to set the
portion, the streams (ops / campaign, or both) and that day's note.

A day tagged with both streams is still **one** day at one rate. The tags are for reporting.

**Payments tab.** Amount, date, method, optional note. The header balance is
`earned − received`.

**Setup tab.** Rate changes apply from today onward and never re-price past days. Export CSV
or raw JSON. Restore from the archive.

---

## The restore drill

**A backup that has never been restored is not a backup.**

1. Uninstall the PWA and clear site data for the origin
2. Reinstall from the Pages URL
3. Setup → username, token, passphrase
4. **Restore from archive**
5. Confirm every day, every payment and the balance come back

Run it before trusting the app, and once a quarter after that. Put it in the calendar.

---

## Tests

```bash
node --test test/*.test.js
```

50 tests, nothing to install. They cover the parts where a mistake is silent rather than
loud: day valuation, corrections superseding, timezone-correct ordering, rate changes not
re-pricing history, the payments ledger, and `earned − received = balance`.

`test/crypto.test.js` pins the most dangerous seam in the system — the phone encrypts with
WebCrypto and the laptop decrypts with Node's classic crypto. It contains a **real envelope
produced by Chrome**, frozen as a fixture. Don't regenerate it casually; being a frozen
artefact of the browser implementation is the entire point.

---

## Phase 0

`src/phase0.html` is the device harness. Open it on the Redmi and it runs the checks itself:
installed-app state, service worker, protected storage, WebCrypto timing, and a live GitHub
write plus a forced conflict recovery. It writes only to `_phase0_probe.txt` and never
touches the real archive.

It also has the test nobody runs: set a marker, run Xiaomi's Security → Cleaner, restart the
phone, come back and see whether browser storage survived. If it did not, that is the single
most important thing to know about this device — and the reason sync fires on every write
rather than on a timer.

---

## Layout

```
daytracker/
├── src/
│   ├── index.html      UI shell and styles
│   ├── app.js          wiring only
│   ├── reducer.js      events → state. PURE, no DOM. All the arithmetic is here.
│   ├── store.js        IndexedDB, append-only
│   ├── crypto.js       AES-GCM 256 + PBKDF2-SHA256 (310k)
│   ├── sync.js         GitHub Contents API, merge, conflict retry
│   ├── config.js       repo coordinates — the only place they appear
│   ├── sw.js           offline shell. Never caches api.github.com.
│   └── phase0.html     device verification harness
├── test/               node --test, zero deps
└── tools/
    ├── pull.mjs        laptop: fetch + decrypt → Finance\
    ├── serve.mjs       local dev server
    └── make-icons.mjs  regenerates the PNG icons from nothing
```

`tools/pull.mjs` is Node rather than PowerShell on purpose: Windows PowerShell 5.1 runs on
.NET Framework, which has no `AesGcm` class and cannot decrypt this format. Node was already
needed for the tests, so it adds nothing to install.

---

## Known limits

- **No home-screen widget.** Android widgets need a native app. This gives an icon and, where
  Chrome supports it, a long-press "Log today" shortcut.
- **No scheduled reminders.** Local scheduled notifications are not reliably available to a
  web app. Use a recurring alarm in the Clock app if a nudge is wanted.
- **Ciphertext changes wholesale on every commit**, so git diffs are unreadable. What survives
  is what matters: every commit is a dated, individually decryptable snapshot.
