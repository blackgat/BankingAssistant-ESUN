# Banking Transfer Assistant (E.SUN) — v0.1

A local-only Chrome / Edge **Manifest V3** browser extension that helps you run a
batch of bank transfers on **your own machine**. You log in, handle 2FA / OTP, and
authorize every transfer yourself. The extension only assists: it checks balance,
fills the agreed form fields, detects page state, loops through multiple transfers,
shows the final balance, and helps you click logout.

> This implements `BankingAssistantBrowserExtension-SPEC.md` v0.1. Target bank for
> this build is **玉山銀行 (E.SUN)**; the bank-specific selectors are placeholders
> you must verify against the real site (see "Replacing the bank selectors").

---

## Safety statement

```
This extension is a local banking transfer assistant.
It does not store bank passwords, OTPs, or full account numbers.
It does not click the final transfer confirmation button.
The user must manually authorize every transfer on the bank verification page.
```

```
本 extension 僅為本機銀行轉帳輔助工具。
它不保存銀行密碼、OTP 或完整帳號。
它不會點擊最終轉帳確認按鈕。
每一筆轉帳都必須由使用者本人在銀行驗證頁手動授權。
```

**What it never does:** store passwords / OTP / OTP seeds / full account numbers /
session or CSRF tokens / raw DOM; enter an OTP; press the final confirm button;
bypass the bank verification page; assume success without observing a completion
page. These boundaries are enforced in code (see "How the boundary is enforced").

---

## Install (load unpacked)

1. Run `npm install` (only needed for tests; the extension itself has no build step).
2. Open `chrome://extensions` (or `edge://extensions`).
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select this folder
   (`banking-assistant-extension/`, the one containing `manifest.json`).
5. Open the **Options** page (right-click the extension → Options, or the link in
   the popup) and set your bank origin, source accounts, designated payees, and
   limits. Defaults are seeded from the SPEC example so the UI is usable immediately.

The content script only runs on `https://*.esunbank.com.tw/*` (no `<all_urls>`).
To target a different host, edit `host_permissions`, `content_scripts[].matches`,
and `web_accessible_resources[].matches` in `manifest.json`.

## Use

1. Log in to the bank yourself in a normal tab.
2. Click the extension icon to open the **popup** and build a batch:
   - pick a source account and a designated payee (both come from your Options config),
   - enter amount, short memo (摘要), long memo (附言), and add the job,
   - repeat for more transfers, or paste a `TransferBatch` JSON and **匯入 JSON**.
3. Click **開始批次**. A fixed overlay appears on the bank page showing progress.
4. For each job the extension fills the form and **stops at the verification page**.
   You complete the bank's verification / OTP and press the bank's confirm button.
5. When the extension observes the **completion page**, it advances to the next job.
6. After the last job it shows the final balance and helps you click logout
   (if the bank asks you to confirm logout, it stops and lets you do it).

At any time, **停止批次** in the overlay halts everything.

---

## Try it without a bank (offline demo)

The demo runs the **real** runner, adapter, overlay, and policy engine against the
HTML fixtures — fully offline — so you can see the human-in-the-loop flow:

```bash
npm run demo
# open http://localhost:8123/demo/harness.html
```

Click **開始批次**. The extension fills the form and stops at the (fake) verification
page. Press the red **確認轉出** yourself to simulate authorizing; the harness then
shows the completion page and the runner advances. The extension never presses that
button for you. The sanitized audit log is printed at the bottom.

---

## Run the tests

```bash
npm test
```

Uses the Node built-in test runner (`node:test`) plus `jsdom` for the DOM fixture
tests. Coverage (SPEC section 15):

- **policy** — pass, amount-over-limit fail, payee mismatch, source mismatch,
  insufficient balance, daily-limit, memo-too-long, verification-page match/mismatch.
- **sanitizer** — account masking, name masking, reference masking, forbidden-key
  dropping, deep redaction of long digit runs.
- **state-machine** — happy path, and that the agent can never reach completion
  except by observing a completion page (no extension-confirm transition exists).
- **safety** — the action allow-list and the adapter expose no final-confirm / OTP
  action; forbidden actions throw.
- **adapter** — `detectPageState`, balance / payee extraction, form filling,
  verification summary, completion result, against `tests/fixtures/*.html`.
- **runner** — a full 2-job batch runs to completion; a mismatching verification
  page stops the batch; the audit log leaks no raw reference or 6+ digit run.

---

## Replacing the bank selectors

All bank-specific knowledge is a plain selector map. The control flow never needs
to change per bank.

1. Open each real E.SUN page while logged in: account home, transfer form,
   verification page, completion page.
2. Inspect the DOM and update the right-hand selector strings in
   [`src/content/extractors/bank-adapter.esun.js`](src/content/extractors/bank-adapter.esun.js)
   (`ESUN_SELECTORS`). The shape is documented in
   [`bank-adapter.example.js`](src/content/extractors/bank-adapter.example.js).
3. Update the matching fixtures in `tests/fixtures/` so the structure mirrors the
   real DOM, then run `npm test` until green.
4. To add another bank: copy `EXAMPLE_SELECTORS`, point it at the new DOM, subclass
   `BaseBankAdapter`, and register it in the `ADAPTERS` map.

Selector strategy is layered and fails closed: explicit selector → label-neighbor
text → regex over visible text. Every read returns a confidence score; anything
below **0.9** stops the batch for manual handling (SPEC section 11). An ambiguous
match (multiple candidate accounts / payees) also fails closed (SPEC section 16).

**E.SUN field notes.** The real E.SUN DOM (iframe architecture, the 3-step wizard,
the label-based fields, the mode radios, where the balance shows) is documented in
[`docs/ESUN-INTEGRATION-NOTES.md`](docs/ESUN-INTEGRATION-NOTES.md), together with the
console probes used to discover it. If E.SUN redesigns, diff the live page against
that snapshot to find what changed.

---

## Architecture

```
manifest.json                 MV3, minimal permissions, E.SUN host only
src/
  background/service-worker.js (module) seeds default config; tiny storage helpers
  content/
    main.js                    classic loader -> dynamic-imports the ESM entry
    main.module.js             wires adapter + overlay + logger + runner on a message
    runner.js                  SPEC section 9 orchestration (env-agnostic, injectable waiter)
    overlay.js                 fixed shadow-DOM overlay; renders sanitized values only
    state-machine.js           batch/job state machines + forbidden transitions
    extractors/
      bank-adapter.example.js  BaseBankAdapter + documented EXAMPLE selector map
      bank-adapter.esun.js     ESUN_SELECTORS + EsunAdapter + adapter registry
    actions/
      transfer-form-actions.js DOM helpers + action allow/deny boundary
  core/
    types.js                   constants, typedefs, DEFAULT_CONFIG
    policy.js                  deterministic batch/job/verification policy (pure)
    sanitizer.js               account/name/reference masking, deep redaction (pure)
    allowlist.js               origin + payee allowlisting (fail closed)
    logger.js                  sanitized audit log (chrome.storage or in-memory)
  popup/                       batch editor (build/import/start a batch)
  options/                     config editor, import/export, audit log download/clear
tests/                         node:test suites + HTML fixtures
demo/                          offline harness that runs the real flow
scripts/serve.mjs              dependency-free static server for the demo
```

**No build system.** Core modules are ES modules (directly unit-testable). The
manifest content script is a classic loader that `import()`s the ESM entry; those
files are listed in `web_accessible_resources`. The service worker is `type: module`.

**Why `all_frames: true` is enabled (SPEC 3.3).** E.SUN's online banking serves
its entire app inside a same-origin iframe (observed: the top page at
`https://ebank.esunbank.com.tw/` embeds `iframe1` →
`https://ebank.esunbank.com.tw/fco/fco08001/FCO08001_Home.faces`, which holds the
real logout control, account list, transfer form, etc.). A top-frame-only content
script sees an empty shell, so `detectLoginState()` fails. With `all_frames: true`
the content script also runs inside that same-origin iframe. The popup broadcasts
`START_BATCH` to every frame, but only the frame whose `detectLoginState()` is
`logged_in` handles it (`thisFrameIsBankApp()` in `main.module.js`); the empty top
frame stays silent. The overlay therefore renders inside the banking iframe.

## How the boundary is enforced

- **No confirm action exists.** `transfer-form-actions.js` defines a closed
  `ALLOWED_ACTIONS` list; `assertActionAllowed()` throws for anything else
  (including `clickFinalConfirm`, `fillOtp`, `approvePush`). Every adapter action
  calls it. Tests assert no adapter method matches a final-confirm / OTP pattern.
- **No confirm transition exists.** In the job state machine, the only edge into
  `COMPLETION_DETECTED` is the `COMPLETION_PAGE_DETECTED` event, which the runner
  emits only after the adapter observes the bank's completion page — never on a
  timer, never after a click. Tests assert this is the sole path.
- **Deterministic policy.** `policy.js` is a pure function of its inputs (no LLM,
  no network). The verification-page check must match payee, account last-5,
  amount, and source before the runner stops for you; any mismatch stops the batch.
- **Sanitized everywhere.** Everything written to the overlay or audit log passes
  through `sanitizer.js`: accounts become `****last5`, names are masked, long digit
  runs and national IDs are redacted, and forbidden keys (password / OTP / token /
  raw DOM) are dropped.

## Timeouts (configurable in Options)

- Wait up to **30s** for the verification page after submit; timeout stops the batch.
- Wait up to **5 minutes** for the completion page while you authorize; during this
  time no confirm button is ever clicked. A completion page advances; an error page
  or your **停止批次** stops.

## Not in v0.1

No cross-bank generic adapter, no OTP handling, no password-manager integration,
no final-submit click, no cloud sync, no raw DOM upload.
