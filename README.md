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

## Live

**App:** https://hamza-ai-eng.github.io/daytracker-app/src/
**Phase 0 harness:** https://hamza-ai-eng.github.io/daytracker-app/src/phase0.html

| Repo | Visibility | Holds |
|---|---|---|
| [`daytracker-app`](https://github.com/Hamza-ai-eng/daytracker-app) | public | this code. No secrets — the token is typed on the phone, never committed. |
| [`daytracker-data`](https://github.com/Hamza-ai-eng/daytracker-data) | **private** | `days.enc.json`, the encrypted record. |

Separate because Pages on a private repo needs Pro and serves publicly anyway.

---

## Setup — what is left

Both repos exist, Pages is live, and the app boots. Two steps remain, and both need a human
because they involve a credential.

**1. Make the token.** GitHub → Settings → Developer settings → Personal access tokens →
**Fine-grained tokens**:

- Repository access: **only `daytracker-data`**
- Permissions → Repository permissions → **Contents: Read and write**
- Set an expiry date, and **write that date down** — the app will start failing loudly when
  it lapses, but knowing in advance is better.

**2. Pick a passphrase and write it on paper.** Lose it and the GitHub archive can never be
read again. The phone's copy survives, but the backup does not.

**Then, on the phone.** Open https://hamza-ai-eng.github.io/daytracker-app/src/ in Chrome →
menu → Add to Home screen. Open it from the icon. Setup tab → username (`Hamza-ai-eng` is
already the default), token, passphrase → **Save & sync now**.

**Laptop.** `cp .env.example .env`, fill it in with a **read-only** token, then:

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

**Monthly retainer.** A flat fee charged every month regardless of days worked. Charged on
the 1st of each month, from the month it starts through the current month. Setting it to 0
stops it from that month onward without erasing anything already charged.

**Fill in past days.** For catching up on a stretch. Pick weekdays plus a date range, and/or
paste one-off dates (`YYYY-MM-DD` or `DD/MM/YYYY`, any separator). Shows exactly how many
days it will add and what they are worth before you commit. Days already logged are left
alone, and the whole batch lands in one commit.

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

## Phase 0 — status

Confirmed on the live site (desktop Chrome at mobile size, 2026-08-25):

| # | Check | Result |
|---|---|---|
| 0.2 | Service worker registers and activates | **PASS** — scope `/daytracker-app/src/`, 12 shell files cached |
| 0.9 | WebCrypto round-trip, wrong passphrase rejected | **PASS** — 79 ms encrypt / 83 ms decrypt |
| — | Manifest parses, 3 icons, "Log today" shortcut | PASS |
| — | All assets served with correct MIME types | PASS |
| 0.4 | Protected storage | `false`, as predicted. Chrome grants it on engagement. This is why sync exists. |

Still open, because they need the actual Redmi or a token:

| # | Check | Needs |
|---|---|---|
| 0.1 | Installs to a standalone home-screen icon | the phone |
| 0.3 | **Survives Xiaomi's Cleaner** | the phone |
| 0.5 | `showSaveFilePicker` on real Android | the phone (desktop says supported; Android will not) |
| 0.6 | Phone can commit to the private repo | the phone + the token |
| 0.7 | Stale-sha conflict recovers | the phone + the token |
| 0.10 | Long-press "Log today" shortcut | the phone |

`src/phase0.html` is the device harness. Open it on the Redmi and it runs the checks itself:
installed-app state, service worker, protected storage, WebCrypto timing, and a live GitHub
write plus a forced conflict recovery. It writes only to `_phase0_probe.txt` and never
touches the real archive.

It also has the test nobody runs: set a marker, run Xiaomi's Security → Cleaner, restart the
phone, come back and see whether browser storage survived. If it did not, that is the single
most important thing to know about this device — and the reason sync fires on every write
rather than on a timer.

---

## Security posture

Reviewed 2026-08-25 by attacking the running app, not by reading the code.

| Concern | Position |
|---|---|
| XSS via notes / event data | All user text reaches the DOM through `textContent`. Verified with live `<img onerror>` and `<script>` payloads in day notes, payment notes and event types — rendered as literal text everywhere, including the crash screen. |
| Crash screen | Was built with `innerHTML`, and its message quotes archive data. A tampered file could have run script on this origin. Rebuilt with `textContent`. |
| Content Security Policy | `script-src 'self'` (inline injection blocked, verified), `connect-src` limited to `api.github.com` (exfiltration blocked, verified), `default-src 'none'`, no framing, no form action. |
| Token and passphrase | `localStorage` on a single-purpose origin with zero third-party script. Never logged, never in a URL, never sent anywhere but api.github.com. The CSP means even a successful XSS could not send them out. |
| Supply chain | No dependencies. Nothing to be compromised upstream. |
| Data at rest (remote) | AES-GCM-256, PBKDF2-SHA256 at 310k. GitHub holds ciphertext. |
| Data at rest (phone) | Plaintext IndexedDB, deliberately — a passphrase on every open would kill the one-tap goal. Not a defence against an unlocked phone in someone else's hands. |
| CSV export | Cells beginning `= + - @` are pinned as text. Excel and Sheets execute them otherwise. |
| Corrupt or tampered archive | Refuses to decrypt and refuses to overwrite. Never guesses. |
| Public repo | Full history scanned for tokens and passphrases. Clean. Only the app code is public; the record is in a separate private repo. |

**Known and accepted:** an unlocked phone gives up the record and the token. Rotate with
`node tools/rekey.mjs` and revoke the token on GitHub if a phone is lost.

## Accessibility and usability

Both colour schemes pass WCAG AA on every measured pair (light 4.58–14.77, dark 4.50–16.06).
Day cells are `role="button"`, focusable, and carry spoken labels. Tap targets are 44px
except the calendar cells at 41px, which is the 7-column grid on a 375px screen and still
well above the 24px minimum.

A tap on a future date does nothing — on a billing record an accidental tomorrow silently
adds a day's rate. Long-press still allows a deliberate entry.

Writes are serialised, so a fast double-tap gives full-then-half rather than full twice.

Being offline reads "Saved here, no connection" and is not styled as an error, because it
is the ordinary case.

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
