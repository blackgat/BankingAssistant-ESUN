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

> ## E.SUN redesigned on or before 2026-10-17 — sections 1 to 9 are now history
>
> The bank moved from a JSF widget inside an iframe to a Vue single-page app at a
> new path. **Sections 1 to 9 below describe the pre-redesign site.** They are kept
> deliberately: this file exists so the old and new DOM can be compared, and that
> comparison is the fastest route to a working adapter.
>
> **For what is true now, and which capabilities broke, read [section 11](#11-the-2026-10-17-redesign).**

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
- **Popup harness — no bank at all.** `demo/popup-harness.html` drives the real popup
  against stubbed `chrome.*` APIs, intercepting and logging `START_BATCH` instead of
  dispatching it, so migration, list switching, the review screen, and last-run
  recording can be exercised offline. `npm run demo`, then open
  `/demo/popup-harness.html`. Exercised end to end on 2026-07-19, and the same paths
  were then confirmed in the installed extension against the real profile.

## 8. Where each finding lives in code

Only the E.SUN-specific parts are listed here; for the whole system's
component-to-file map see the table at the end of `docs/architecture.html`.

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
  See figure 8 of `docs/architecture.html` for the data model and diagram.


---

## 11. The 2026-10-17 redesign

**Observed:** 2026-10-17, live logged-in session, read-only digit-redacted probes
driven through the `chrome-devtools` MCP. No transfer was made and no value was
entered; everything below came from reading the DOM of the account home page and
an empty transfer form.

### What changed at the architecture level

| | Before (sections 1-9) | Now |
|---|---|---|
| Entry URL | `https://ebank.esunbank.com.tw/index.jsp` | `https://ebank.esunbank.com.tw/esb/` |
| App location | same-origin `#iframe1` → `FCO08001_Home.faces` | **top document, zero iframes** |
| Stack | JSF widgets, class-less markup, dynamic ids | **Vue SPA**, stable-looking class names |
| Page identity | one URL for the whole wizard | **real routes**, e.g. `/esb/deposit/twd-transfer/edit` |
| Login marker | `a.log_out` | gone; 登出 is an `<a class="modal-second-button">` |

The route is the important gain. The old adapter had to read the wizard's step
text because every step shared a URL; the new app puts the step in the path, which
is a far steadier signal than matching Chinese label text.

### Capability verdict

| Capability | Verdict | Why |
|---|---|---|
| Login detection | **broken** | `a.log_out` no longer exists. Nothing else runs, because the runner stops here. |
| iframe + `all_frames` + frame gating | **removed 2026-10-17** | No iframes at all. `all_frames` is gone from the manifest; the guard it was paired with lives on as `pageIsBankApp()`, which checks the two things that always mattered — allowed origin, signed-in session. |
| Wizard page-state | **broken as written** | `.step .current` matches 0 nodes. The words 資料編輯 / 資料確認 still exist, in elements of class `content`, and 資料編輯 is the one marked active. Prefer the route. |
| Navigate to transfer | **broken** | Was a side-menu link; now a `<button>` reading 臺幣轉帳 (note 臺, not 台) plus SPA routing, so the post-click wait changes too. |
| Select source account | **broken** | Was a `<select>`. Now a **`readOnly` `input.combo-input`** inside `.combo-input-wrapper` — it has to be clicked to open a picker; setting `.value` will do nothing. |
| Select destination payee | **broken** | Same combo-input pattern. |
| 約定 / 即時 radios | **broken semantics** | There are now **two independent radio groups**, not one choice: payee source (最近轉帳 ✓ / 常用、約定帳號 / 自行輸入) and timing (即時轉帳 ✓ / 預約單日 / 預約週期). The old `modes: {designated:/約定/, instant:/即時/}` happens to hit a plausible target in each group, but it is matching across two different axes by luck. |
| Available balance | **at risk** | The 可用餘額 label still exists (class `mib-remark`), but the old read depends on first driving a `<select>`, which is gone. |
| Amount field | **probably fine** | Still a plain editable `input[type=text]`, placeholder 請輸入轉帳金額. |
| Memo fields (two) | **at risk** | Both are `input[type=text]` with placeholder 限NN個中英數字. Walking up from the input found **「備註給對方」 for both**, so the two are not distinguishable by that method and the adapter could fill the wrong one. The verification-page `memo_*_match` check would catch it and stop the batch, so this misfires safely — but it does misfire. |
| Submit (下一步) | **probably fine** | `<button class="btn-main-fill">下一步</button>`, text unchanged. |
| Verification-page extraction | **untested** | Needs the 資料確認 step, which needs a filled form. |
| Completion-page extraction | **untested** | Needs a real transfer. |
| Named lists, policy, state machine, sanitizer, backup | **unaffected** | All pure, no DOM. |

### Scope of the repair

Everything that broke lives in
[`bank-adapter.esun.js`](../src/content/extractors/bank-adapter.esun.js) (495 lines)
plus `tests/fixtures/*`. Of the 89 unit tests only the ~10 adapter tests depend on
the bank's DOM; policy, lists, state machine, sanitizer and backup are untouched.
This is the payoff for having confined every bank-specific assumption to one file.

It is a rewrite of that adapter, not a patch — the selector strategy itself changed,
from "find a label, walk to its control" against class-less JSF output, to a Vue app
with routes and named classes.

### Re-inspection probes for the new site

Run from the page console (no iframe hop any more). Digits redacted.

```js
// Page identity and step, from the route
JSON.stringify({ path: location.pathname, step: location.pathname.split("/").pop() });
```

```js
// Labelled controls on the transfer form
const red = s => (s||"").replace(/\d/g,"#").replace(/\s+/g," ").trim().slice(0,48);
JSON.stringify([...document.querySelectorAll("input,select,textarea")]
  .filter(e => e.type !== "hidden")
  .map(e => ({ type: e.type, cls: red(e.className), ph: red(e.placeholder), ro: e.readOnly })));
```

```js
// Both radio groups, with which option is selected
const txt = e => (e?.textContent||"").replace(/\s+/g," ").trim();
JSON.stringify([...document.querySelectorAll("input[type=radio]")].map(r => ({
  label: txt(r.closest("label")) || txt(r.parentElement), checked: r.checked })));
```

### The 資料確認 step (probed 2026-10-17, no transfer made)

Route `/esb/deposit/twd-transfer/confirm`. The step really is in the path:
`edit` → `confirm`. Expect `result` or similar for the third, unconfirmed.

> #### The one that could move money by accident
>
> The final button on this step is **`<button class="btn-main-fill">立即交易</button>`**.
> The 下一步 button on the *edit* step has **the same class**, `btn-main-fill`.
>
> A submit selector written as `.btn-main-fill` would therefore press 下一步 on the
> edit page and **execute the transfer** on the confirm page. Match on the button's
> text, and treat 立即交易 the way `clickFinalConfirm` is treated: a name with no
> implementation. The other button here is 修改 (`btn-main-border`), which goes back.

> #### The password now lives on the page the extension parks on
>
> The confirm step carries `<input type="password" placeholder="請輸入您的使用者密碼">`.
> The user authorises by typing their banking password right here, rather than on a
> later screen.
>
> Nothing in the extension can fill it — there is no action for it and the sanitizer
> refuses credential-shaped keys — but the boundary is now physically on the same
> page as the form the adapter fills, so keep it that way deliberately. Add 立即交易
> and this field to whatever the rewrite uses as its refusal list.

Label-to-value pairing on this step, as measured (values themselves not recorded):

| Field | Label element | Value |
|---|---|---|
| 轉出帳號 | `div.info-header` | next sibling `div`, contains digits |
| 轉帳金額 | `div.info-header.mib-font-bold` | **not a sibling** — needs a different walk |
| 備註給自己 / 給對方 | `div.info-header` | next sibling `div`; an empty memo renders as `-` |
| 轉入帳號 | matched an `<a class="mib-underline mib-obvious">` | the probe hit a link, not a label cell; needs a tighter match |

So the old "find the label cell, take its sibling" shape survives for the source
account and both memos, but not for the amount, and the payee needs a selector that
does not collide with a link. An empty memo reading as `-` matters: the policy
compares memos, and `-` is not the empty string.

The wizard words 資料編輯 / 資料確認 are both present on this step and both carry
class `content`, with nothing distinguishing the active one — another reason to read
the route instead of the step text.

### The account picker (probed 2026-10-17)

Clicking the `readOnly` `input.combo-input` opens a dialog rather than a dropdown.
The wrapper gains `modal-open`, and the dialog is:

```
div.combo-modal[role="dialog"]
  div.modal-header
  div.custom-area
     …  li[role="button"]        ← one per account
  div.modal-footer
```

Each row's text is the account number followed by its nickname, and the currently
chosen row carries `class="selected"`. Six rows were present on the probed account.

This is a better target than the old `<select>`: the config already stores
`accountLast5` and `displayNamePattern`, and both appear in the row text, so the
existing matching rules carry over unchanged. The sequence for the rewrite is

1. click the trigger (locate it by its placeholder or its label, not by position),
2. wait for `.combo-modal[role=dialog]`,
3. pick the `li[role=button]` whose text matches the configured account,
4. click it, then wait for the dialog to close **and** the input's value to change —
   both, because either alone can be true while the other has not happened yet.

Setting the input's `.value` directly will not work: it is `readOnly` and the app
holds the real state.

**Dismissal.** The close control is in the header:

```html
<button class="toggle mib-hover" aria-label="關閉"></button>
```

It carries no text, so match it on `aria-label="關閉"` within `.modal-header`.
**Escape does not close the dialog** (confirmed 2026-10-17), so the adapter has to
click that button; it cannot rely on a key press. Treat "opened the picker, no row
matched" as a stop that closes the dialog first, and keep re-navigating to the
`/edit` route as the fallback if the close ever fails — a fresh page load is the
one recovery that does not depend on finding an affordance.

> **The picker is not reliably present the instant it opens.** An earlier probe in
> the same session queried `.combo-modal` while the picker was open on screen and
> got **nothing back**; a later probe found it visible, `display: flex`, 1060x398,
> with all six rows. The dialog is re-rendered rather than merely shown, so a
> single `querySelector` can miss it.
>
> This is the same shape as the bug that produced "無法進入轉帳表單頁" on the second
> job of a batch: a transient absence read as a hard fact. Every wait against this
> app has to poll until a deadline, and treat "not found yet" as *keep waiting*,
> never as *not there*.

### Login marker, and a session timer that can interrupt a batch

`a.log_out` is gone. The signed-in signals now available:

| Signal | Shape | Use |
|---|---|---|
| Logout control | `div.header-option-entry-button` whose text is 登出 (also `.header-option-entry-text`) | **the marker** — match the text inside the site header, not a class alone |
| Session countdown | `div.countdown-block`, text `NNN 秒後自動登出，點擊重新計時` | corroborating, and see below |
| Route | path begins `/esb/` | weak on its own; a logged-out SPA may still hold the route briefly |

Do **not** use the `localStorage` keys (`mibKeepMe`, `custidIcon`, `nameIcon`,
`pxsswdIcon`, `mibPlatform`) as proof of a session. They look like remembered
preferences and would survive a logout, so they answer the wrong question.

> #### The session now logs itself out, and a batch is long
>
> The header carries a live countdown — `NNN 秒後自動登出，點擊重新計時` — and the
> page has a timeout dialog already in the DOM, hidden, containing 即將被登出!
> with two buttons: **繼續使用** (`modal-default-button`) and **立即登出**
> (`modal-second-button`).
>
> The real four-job batch on 2026-09-12 took about nine minutes, most of it spent
> waiting for a person to authorise each transfer. That is well inside the range
> where this dialog can appear mid-batch, cover the form, and make the next step
> fail for a reason that has nothing to do with the transfer.
>
> Two consequences for the rewrite. The adapter must recognise the dialog and
> stop cleanly rather than mis-read it as a broken page — note that 繼續使用 was
> picked up as a *submit candidate* by a naive text probe on the edit page, so a
> loose button match would click the wrong thing. And **立即登出 must never be
> clicked**: add it beside 立即交易 in the refusal list.
>
> Whether the extension should press 繼續使用 to hold the session open is a design
> question, not an obvious yes: it keeps a bank session alive on the user's
> behalf. Left undecided here.

### Two things the picker does that reading the DOM does not reveal

Both were found by running the rewritten adapter against the live form on
2026-10-17 and watching it fail. Neither is visible in a static probe.

**The payee list is behind a tab the dialog does not open on.** Choosing the
常用/約定帳號 radio is not enough. The dialog still opens on its **常用帳號** tab,
which held one row, while the designated accounts the batch transfers to are on
**約定帳號**, which held ten. The tabs are `div[role="tab"]` inside
`.out-account-tab-header`, and the active one carries `selected`. A dialog
reporting "no matching account" while the account plainly exists is this.

```
div.out-account-tab-button.selected  role=tab   常用帳號    ← opens here, 1 row
div.out-account-tab-button           role=tab   約定帳號    ← 10 rows
```

There is also a keyword search (`input.curr-combo-input`) in the dialog, unused
by the adapter but a possible fallback if the tab markup moves again.

**The first click after changing the payee radio is swallowed.** Measured:

```
click 最近轉帳 → click 常用/約定帳號 → click the payee trigger immediately
  the trigger is the SAME DOM node afterwards
  the dialog never opens — waiting 6s does not help
  clicking again 600ms later opens it in 120ms
```

So the component is re-initialising and discards the click without any signal.
The adapter opens with up to three attempts, re-querying the trigger each time,
rather than treating one dead click as "there is no picker". Both behaviours are
pinned by regression tests, because both look like redundant code to anyone
tidying up later.

### What the live test did and did not prove (2026-10-17)

Driven through `DRY_RUN_FILL`, which fills the form and cannot advance or submit:

| Checked | Result |
|---|---|
| Login detection without `all_frames` | passes |
| Route → page state | `/edit` reads as `transfer_form` |
| Source picker | selects the configured account |
| Payee picker, after the two fixes | selects the right one, confirmed by last-5 |
| Amount | filled |
| **Memos not swapped** | 給自己 and 給對方 each received their own distinct value |
| **No dialog left covering the form on failure** | zero open dialogs after every failed pick |
| Available balance | 0.95 |

Still unproven: **the completion step**. It needs a real transfer, so
`readCompletion` deliberately returns confidence below the runner's threshold —
the next real batch will stop at the completion page and ask rather than record
a transfer as done on an unverified reading. Raise it only after seeing that page.
