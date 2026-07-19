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
  picks the one whose options actually contain the configured payee
  (`_trySelectPayee`); if none does, it clicks 約定常用帳號 and retries.

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
  last-5 (digits in the cell), amount. Source last-5 is **not shown** on this page.
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
  (`login`, `wizard`, `form`, `labels`, `modes`, `verification`, `completion`,
  `accounts`, `payees`) and the `EsunAdapter` overrides:
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
