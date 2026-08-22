# E.SUN (玉山) Online Banking — Integration Field Notes

**Observed:** 2026-06-22, on the live personal online bank
(`https://ebank.esunbank.com.tw`), logged-in session.

**How this was gathered:** read-only, digit-redacted DOM probes run from the
browser console (and via the Chrome connection). No account numbers, balances, or
personal data are recorded here; recipient names are shown generically (e.g.
`〔收款人〕`, `張○○`). 

**Why this file exists:** a snapshot of E.SUN's real DOM as it was when the adapter
was built. If E.SUN redesigns its online banking, diff the live page against these
notes to find what changed, then update
[`src/content/extractors/bank-adapter.esun.js`](../src/content/extractors/bank-adapter.esun.js)
(`ESUN_SELECTORS` + `EsunAdapter`) and `tests/fixtures/*`.

---

## 1. Page architecture

- The top page `https://ebank.esunbank.com.tw/index.jsp` is a thin shell.
- The **entire banking app runs inside ONE same-origin iframe**:
  `#iframe1` → `https://ebank.esunbank.com.tw/fco/fco08001/FCO08001_Home.faces`
- It is a **JSF widget SPA**. Functional elements are largely **class-less with
  dynamic ids**, so the adapter locates everything by **visible label text / wizard
  step text**, not by CSS id/class.
- Consequence: `manifest.json` needs `"all_frames": true` so the content script runs
  inside the iframe (the top frame is empty). Only the frame whose
  `detectLoginState() === 'logged_in'` handles a batch — see `thisFrameIsBankApp()`
  in [`main.module.js`](../src/content/main.module.js).

## 2. Login state

- Logged-in marker: **`<a class="log_out">`** (the "登出" link), inside the iframe.
- The top frame has no `log_out` marker, which is why a top-frame-only content script
  reported "not logged in".
- `ESUN_SELECTORS.login.loggedInMarkers = ["a.log_out", ...]`.

## 3. Transfer flow = a 3-step wizard inside one widget

- **Entry:** left-menu `<a>` whose text is **"即時 / 預約轉帳"**. It has **no href/id**;
  it loads a widget via `onclick="_leftMenuLoadWidget(event,'FCP03003','FCP',...)"`.
  Matched by text: `form.navToTransferText = /即時.*預約.*轉帳|預約轉帳|即時轉帳/`.
- **Step indicator** (the reliable page-state signal):
  `<div class="step"> … <dt class="current">Step{n}{name}</dt>`
  - `資料編輯` → page state **`transfer_form`**
  - `資料確認` → page state **`verification`**  ← the extension STOPS here
  - `交易結果` → page state **`completion`**
  - `ESUN_SELECTORS.wizard.{stepCurrent, formStepText, verifyStepText, completeStepText}`;
    handled in `detectPageStateDetailed()`.

## 4. 資料編輯 (transfer form) — fields are label-based

| Purpose | E.SUN label / text | Element | Adapter hook |
|---|---|---|---|
| Source account | `轉出帳號` | `<select>` (selectone) | `labels.source` |
| Payee mode | `轉入帳號` | radios: **約定常用帳號** / 最近轉帳帳號 / 其它帳號 | `modes.designated = /約定/` |
| Designated payee | `轉入帳號` | `<select>` (first option `請選擇`) | `labels.payee` + `_trySelectPayee()` |
| Transfer mode | (group) | radios: **即時預約單日** (default checked) / 預約週期 / 每月 / 每週 | `modes.instant = /即時/` |
| Amount | `轉帳金額` | text `<input>` | `labels.amount` |
| Memo to self | `撰寫備註給自己` | text `<input>` (placeholder 限N個中英數字) | `labels.memoSelf` → `memoShort` |
| Memo to recipient | `撰寫備註給對方` | text `<input>` | `labels.memoOther` → `memoLong` |
| Available balance | `可用餘額` | `<span>` whose **own text** is `可用餘額`; the number is in a child node; **only appears after a 轉出帳號 is selected** | `readBalance()` override |
| Advance | `下一步` | `<a>` | `labels.nextLinkText` — goes to 資料確認, **NOT** the final confirm |
| Auth method | (group) | radios: 簡訊密碼 / 晶片金融卡 | user handles (never touched) |

Notes:
- **Balance timing:** `可用餘額` only renders once the source account is selected and
  is AJAX-computed. `readBalance()` therefore selects the source itself, ensures 即時,
  and polls (~3 s max) for the value — so the user does **not** need to pre-select.
  It still requires being on the transfer form; otherwise it fails closed (or turn the
  check off via `behavior.requireBalanceCheck`).
- **Multiple `轉入帳號` selects** exist (約定 list, 玉山 行內, 他行 manual). The adapter
  clicks 約定常用帳號 **first** so the designated dropdown is the live 轉入帳號 input,
  then calls `_trySelectPayee`, which scans those selects for one whose options match
  the configured payee. Because the radio click can re-render the dropdown over AJAX,
  a failed first attempt is retried for ~1 s (8 × 120 ms) before falling back to the
  generic selector path.

## 5. 資料確認 (verification) — table layout

- Each field is a **label cell (`th` or `td`) + an adjacent value cell (`td`)**.
  Read via `_confirmCellValue(labelRe)`.
- Fields observed:
  - `轉出帳號` → source account nickname (e.g. 〔暱稱〕)
  - `轉入帳號` → `〔收款人〕 (約定) 〔帳號〕 玉山銀行 〔帳戶暱稱〕`
  - `轉帳金額` → amount (digits)
  - `轉帳日期` → date
- The **payee name is already masked by E.SUN** with a middle `○` (e.g. `張○○`), and
  is **not always present** (sometimes the cell shows only `約定 + 玉山銀行 + 帳戶暱稱`).
  Because of this, the verification policy treats the **destination last-5 as the
  authoritative identity**: when last-5 matches, a name-format difference does NOT
  block (`destination_name_match` defers to last-5 in `evaluateVerificationPolicy`).
- **Half-width → full-width:** E.SUN renders half-width input (memos like `2026-06`,
  and amounts) as **full-width** (`２０２６－０６`) on the confirm page. Comparisons are
  therefore done after **NFKC** normalization (`textEquivalent` / `normalizeForCompare`
  in policy.js; `parseAmount` also NFKC-normalizes). Don't switch these back to exact
  string equality.
- `readVerificationSummary()` extracts: payee name (text before `約定`/`(`), payee
  last-5 (digits in the cell), amount, **both memos** (`/給自己|摘要/` and
  `/給對方|附言/`), and source last-5 from the 轉出帳號 cell when present.
  The memos are load-bearing: whenever the confirm page shows them they feed
  `memo_short_match` / `memo_long_match` in `policy.js`, so a memo that doesn't match
  the job stops the batch. This is why the NFKC normalization below matters.
- The **final 確認/送出 button and the OTP (簡訊密碼)** are on THIS step and are the
  user's to perform. The extension never clicks them.

## 6. 交易結果 (completion) — VERIFIED (2026-07-19)

- Only appears after a **real, fully-authorized transfer** completes.
- Verified on a real transfer: `detectPageState()` reports `completion` from the
  wizard step (`交易結果`), and `readCompletion()` reads the transaction serial from a
  cell labelled `交易序號 / 序號` — a **date-prefixed** number (e.g. masked `202****388`).
- The reference label regex intentionally excludes the bare `代號` (it also matches
  `使用者代號`).
- Confirmed via the audit log's `completion_detected` event (`bankReferenceMasked`)
  rather than a live DOM read, so the exact cell label was inferred. If a future
  transfer shows a wrong/empty reference, re-check the 交易結果 page labels live.

## 7. How to re-inspect (if E.SUN changes)

Open the bank, `F12` → **Console** (default `top` context — no context switch). These
reach into the iframe and redact digits, so they never print account numbers/balances.

Transfer-form fields:
```js
const d = document.querySelector("#iframe1").contentDocument;
const red = s => (s||"").replace(/\d/g,"#").replace(/\s+/g," ").trim().slice(0,40);
const form = [...d.querySelectorAll("form")].find(f => /轉出帳號|轉入帳號|金額/.test(f.textContent||""));
const labelOf = el => { const b=el.closest("dd,td,li,p,div"), p=b&&b.previousElementSibling, dl=el.closest("tr,dl"); return red(el.getAttribute("aria-label")||(p&&p.textContent)||(dl&&dl.querySelector("dt,th,label")||{}).textContent||""); };
JSON.stringify([...form.querySelectorAll("input,select,textarea,button")].slice(0,34).map(el=>({tag:el.tagName,type:(el.type||"").replace(/[^a-z]/g,""),label:labelOf(el)})));
```

Verification table (run while on 資料確認):
```js
const d = document.querySelector("#iframe1").contentDocument;
const keep = s => (s||"").replace(/[^一-鿿（）：，。元○]/g,"").slice(0,24);
const cell = re => { const c=[...d.querySelectorAll("th,td,dt,dd")].find(x=>x.childElementCount===0&&re.test((x.textContent||"").trim())); if(!c) return null; let v=c.nextElementSibling||[...(c.closest("tr,dl")||{children:[]}).children].find(x=>x!==c); return v?keep(v.textContent):null; };
JSON.stringify({ source:!!cell(/轉出帳號/), payeeName:(cell(/轉入帳號/)||"").slice(0,1), amount:!!cell(/轉帳金額|金額/) });
```

Mode radios:
```js
const d = document.querySelector("#iframe1").contentDocument;
const form = [...d.querySelectorAll("form")].find(f => /轉出帳號|轉入帳號/.test(f.textContent||""));
const lab = r => { const L=r.id&&[...d.querySelectorAll("label")].find(l=>l.htmlFor===r.id); return ((L&&L.textContent)|| (r.nextSibling&&r.nextSibling.textContent)||"").replace(/[^一-鿿]/g,"").slice(0,12); };
JSON.stringify([...form.querySelectorAll("input[type=radio]")].map(r=>({label:lab(r),checked:r.checked})));
```

Available balance (run while on the form with a source selected):
```js
const d = document.querySelector("#iframe1").contentDocument;
const dt = el => [...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join("").trim();
const el = [...d.querySelectorAll("span,div,td,dd,p,li")].find(e=>/可用餘額/.test(dt(e)));
JSON.stringify({ found: !!el, parses: el ? !isNaN(Number(((el.textContent||"").match(/[\d,]+/)||[""])[0].replace(/,/g,""))) : false });
```

Or use the extension itself:
- **Popup → 測試填表(不送出):** fills the open transfer form via the adapter (radios +
  fields) without advancing — verify the field mapping live.
- **Console (switch context to the iframe's extension world):**
  `await __bankingAssistant.pageState()`, `.balance()`, `.verification()`, `.payees()`.

## 8. Where each finding lives in code

- [`manifest.json`](../manifest.json) — `all_frames`, `host_permissions: https://*.esunbank.com.tw/*`.
- [`bank-adapter.esun.js`](../src/content/extractors/bank-adapter.esun.js) — `ESUN_SELECTORS`
  (`login`, `pages`, `wizard`, `form`, `labels`, `modes`, `verification`, `completion`,
  `accounts`, `payees`, `logout`) and the `EsunAdapter` overrides:
  `detectPageStateDetailed`, `navigateToTransferForm`, `selectSourceAccount`,
  `selectDestinationPayee` / `_trySelectPayee`, `fillAmount`, `fillMemoShort/Long`,
  `submitFormToVerificationPage`, `readBalance`, `readVerificationSummary`,
  `readCompletion`, and helpers `_transferForm`, `_labelTextFor`, `_controlByLabel`,
  `_confirmCellValue`, `_wizardStep`, `_radioLabelText`, `_selectRadioByText`.
- [`main.module.js`](../src/content/main.module.js) — `thisFrameIsBankApp`,
  `runDryRunFill` (popup "測試填表"), and the read-only `__bankingAssistant` console hook.

## 9. Verification status (as of 2026-06-22)

| Capability | Status |
|---|---|
| Login detection (`a.log_out`) | verified live |
| iframe + `all_frames` + frame gating | verified live |
| Wizard page-state (資料編輯/資料確認/交易結果) | verified live |
| Navigate to transfer (menu by text) | verified live |
| Available-balance read (`可用餘額`) | verified live |
| 約定 / 即時 radio handling | matcher verified live; click-path via popup test |
| Form fill (source/payee/amount/memos) | verified live (`dryRunFill` all ok) |
| Submit → 資料確認 (`下一步`) | verified live |
| Verification-page extraction | verified live |
| Completion-page extraction (`交易結果`) | verified on a real transfer (2026-07-19) |
| Multi-job batch (job 2 re-enters the form) | verified on a real 2-job batch (2026-07-19) |
| Balance read after navigating from the dashboard | verified on the live bank (2026-07-19) |
| Named lists + migration of the legacy draft | verified in the popup harness and on the real profile |

## 10. Resolved limitations (kept for context)

No open items at the time of writing. Each entry below records a real constraint that
was hit, why it behaved that way, and how it was resolved — useful when a future
E.SUN redesign makes one of them resurface.

- ~~**`readBalance` requires being on the transfer form before starting a batch.**~~
  **Fixed 2026-07-19.** E.SUN shows `可用餘額` only on the 資料編輯 form (after a 轉出帳號
  is selected), and the runner reads the balance *before* it navigates, so starting a
  batch from another page used to fail with `account_not_found`. `readBalance` now
  escalates: read the DOM → select the source and await the AJAX value → try the
  generic account-row reader → and only then navigate to the transfer form itself
  (click 即時 / 預約轉帳), wait for the source `<select>`, and read. The generic reader
  is tried *before* navigating on purpose: a page that lists balances directly (demo
  fixtures, other banks) must not be navigated away from.
  Confirmed on the live bank 2026-07-19: starting a batch from the account dashboard
  now navigates, selects the source, and reads 可用餘額 (34 checks passed; the only
  failure was an unrelated balance-sufficiency stop).

- ~~**One anonymous pending list kept between runs.**~~ **Superseded 2026-07-19 by
  named lists.** The old `pendingBatch` was a single unnamed draft that survived
  dispatch; with no saved-lists feature that persistence *was* the "reuse last
  month's transfers" mechanism, but it had no name, no last-run record, and
  dispatch always sent every job in it. (Observed that day: four jobs accumulated
  across test runs and the batch precheck correctly stopped on
  `balance_sufficient`.) `src/core/lists.js` now stores several **named** lists
  under `transferLists`; the popup lists them with per-list counts and totals, the
  user picks which to run, each list records its last run, and dispatch is gated
  behind a review screen that itemizes what is about to be sent and warns when the
  list already ran. `migrateState()` carries any legacy `pendingBatch` into a list
  named 先前的清單 — verified on the real profile, four queued transfers intact.
  The legacy key is read but never deleted, so the old draft remains recoverable.
  See `docs/draft-accumulation.html` for the walkthrough and diagram.

- **Verifying the list UI needs no transfer.** `demo/popup-harness.html` drives the
  real popup against stubbed `chrome.*` APIs: `START_BATCH` is intercepted and
  logged rather than dispatched, so migration, switching, the review screen, and
  last-run recording can all be exercised offline. Run `npm run demo` and open
  `/demo/popup-harness.html`.
