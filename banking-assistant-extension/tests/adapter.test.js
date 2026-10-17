import { test } from "node:test";
import assert from "node:assert/strict";
import { loadFixtureDom, loadDom } from "./dom-helper.js";
import { EsunAdapter } from "../src/content/extractors/bank-adapter.esun.js";
import { DEFAULT_CONFIG } from "../src/core/types.js";

const config = DEFAULT_CONFIG;
const source = config.sourceAccounts[0]; // last5 12345
const payee = config.destinationPayees[0]; // last5 67890

function adapterFor(fixture) {
  const doc = loadFixtureDom(fixture);
  return new EsunAdapter({ root: doc, config });
}

test("detectLoginState: home is logged in", () => {
  assert.equal(adapterFor("bank-home.html").detectLoginState(), "logged_in");
});

test("detectPageState distinguishes all fixtures", () => {
  assert.equal(adapterFor("bank-home.html").detectPageState(), "home");
  assert.equal(adapterFor("transfer-form.html").detectPageState(), "transfer_form");
  assert.equal(adapterFor("verification.html").detectPageState(), "verification");
  assert.equal(adapterFor("completion.html").detectPageState(), "completion");
  assert.equal(adapterFor("error.html").detectPageState(), "unknown");
});

test("readBalance extracts the matching account balance with high confidence", async () => {
  const a = adapterFor("bank-home.html");
  const r = await a.readBalance(source);
  assert.ok(r.confidence >= 0.9, `confidence ${r.confidence}`);
  assert.equal(r.value.balance, 50000);
  assert.equal(r.value.accountLast5, "12345");
});

test("extractCurrentBalance convenience wrapper works", async () => {
  const a = adapterFor("bank-home.html");
  assert.equal((await a.extractCurrentBalance(source.id)).balance, 50000);
});

test("readDestinationPayees lists designated payees", () => {
  const a = adapterFor("transfer-form.html");
  const r = a.readDestinationPayees();
  const last5s = r.value.map((p) => p.accountLast5);
  assert.deepEqual(last5s.sort(), ["11111", "67890"]);
});

test("form fill actions update the DOM", async () => {
  const doc = loadFixtureDom("transfer-form.html");
  const a = new EsunAdapter({ root: doc, config });

  assert.equal((await a.selectSourceAccount(source)).ok, true);
  assert.equal(doc.querySelector("select.ba-source").value, "src-12345");

  assert.equal((await a.selectDestinationPayee(payee)).ok, true);
  assert.equal(doc.querySelector("select.ba-payee").value, "payee-67890");

  assert.equal((await a.fillAmount(3000)).ok, true);
  assert.equal(doc.querySelector(".ba-amount").value, "3000");

  assert.equal((await a.fillMemoShort("家用")).ok, true);
  assert.equal(doc.querySelector(".ba-memo-short").value, "家用");

  assert.equal((await a.fillMemoLong("2026-06 家用")).ok, true);
  assert.equal(doc.querySelector(".ba-memo-long").value, "2026-06 家用");
});

test("readVerificationSummary extracts sanitized fields", () => {
  const a = adapterFor("verification.html");
  const r = a.readVerificationSummary();
  assert.ok(r.confidence >= 0.9, `confidence ${r.confidence}`);
  assert.equal(r.value.amount, 3000);
  assert.equal(r.value.destinationAccountLast5, "67890");
  assert.equal(r.value.sourceAccountLast5, "12345");
  assert.equal(r.value.destinationPayeeNameMasked, "張*"); // masked, not raw "張三"
  assert.equal(r.value.memoShort, "家用");
  assert.equal(r.value.pageState, "verification");
});

test("readCompletion extracts a masked reference and completion text", () => {
  const a = adapterFor("completion.html");
  const r = a.readCompletion();
  assert.ok(r.confidence >= 0.9, `confidence ${r.confidence}`);
  assert.equal(r.value.bankReferenceMasked, "ESN****789"); // never the raw reference
  assert.match(r.value.completionText, /交易完成/);
});

test("submitFormToVerificationPage clicks the next button, never a final-confirm", async () => {
  const doc = loadFixtureDom("transfer-form.html");
  const a = new EsunAdapter({ root: doc, config });
  let clicked = null;
  doc.querySelector(".ba-next").addEventListener("click", () => (clicked = "ba-next"));
  const res = await a.submitFormToVerificationPage();
  assert.equal(res.ok, true);
  assert.equal(clicked, "ba-next");
});
// --- the 2026-10-17 redesign --------------------------------------------
// E.SUN replaced the JSF iframe with a Vue app. These exercise the paths that
// only exist on the new site; the fixtures above still cover the generic bank,
// which the adapter falls back to when it does not recognise E.SUN's markup.

const EDIT_URL = "https://ebank.esunbank.com.tw/esb/deposit/twd-transfer/edit";
const CONFIRM_URL = "https://ebank.esunbank.com.tw/esb/deposit/twd-transfer/confirm";

/** A page shaped like the redesigned transfer form, with a working picker. */
function newSiteForm({ rows = ["000000012345 零用金", "000000099999 其他"] } = {}) {
  const doc = loadDom(
    `<!DOCTYPE html><html><body>
      <header><div class="header-option-entry-button"><span class="header-option-entry-text">登出</span></div></header>
      <form>
        <div class="combo-input-wrapper input-mode">
          <input class="combo-input" readonly placeholder="請選擇轉出帳號">
        </div>
        <div class="combo-input-wrapper input-mode">
          <input class="combo-input" readonly placeholder="請選擇轉入帳號">
        </div>
        <label><input type="radio" name="g1">常用/約定帳號</label>
        <label><input type="radio" name="g2">即時轉帳</label>
        <input type="text" placeholder="請輸入轉帳金額">
        <div><div class="info-header">備註給自己</div><input type="text" placeholder="限20個中英數字"></div>
        <div><div class="info-header">備註給對方</div><input type="text" placeholder="限20個中英數字"></div>
        <div id="bal"></div>
        <button class="btn-main-fill" type="button">下一步</button>
      </form>
      <div id="host"></div>
    </body></html>`,
    EDIT_URL,
  );

  // Clicking a readOnly trigger opens the dialog, as the real app does.
  for (const trigger of doc.querySelectorAll("input.combo-input")) {
    trigger.addEventListener("click", () => {
      doc.getElementById("host").innerHTML = `
        <div class="combo-modal" role="dialog">
          <div class="modal-header"><button class="toggle" aria-label="關閉"></button></div>
          <div class="custom-area"><ul>${rows.map((r) => `<li role="button">${r}</li>`).join("")}</ul></div>
        </div>`;
      for (const li of doc.querySelectorAll(".combo-modal li")) {
        li.addEventListener("click", () => {
          trigger.value = li.textContent;
          doc.getElementById("host").innerHTML = "";
          doc.getElementById("bal").innerHTML = `<div><span>可用餘額</span><span>50,000</span></div>`;
        });
      }
      doc.querySelector(".combo-modal button[aria-label='關閉']")
        .addEventListener("click", () => { doc.getElementById("host").innerHTML = ""; });
    });
  }
  return doc;
}

test("new site: page state comes from the route, not the step text", () => {
  const edit = new EsunAdapter({ root: newSiteForm(), config });
  assert.equal(edit.detectPageState(), "transfer_form");

  const confirm = new EsunAdapter({
    root: loadDom(`<!DOCTYPE html><html><body><input class="combo-input"></body></html>`, CONFIRM_URL),
    config,
  });
  assert.equal(confirm.detectPageState(), "verification");
});

test("new site: the header 登出 control is the login marker", () => {
  const a = new EsunAdapter({ root: newSiteForm(), config });
  assert.equal(a.detectLoginState(), "logged_in");
});

test("new site: selecting a source drives the picker dialog and reveals 可用餘額", async () => {
  const doc = newSiteForm();
  const a = new EsunAdapter({ root: doc, config });
  const acct = { id: "s1", accountLast5: "12345", label: "零用金" };

  assert.equal(await a.selectSourceAccount(acct), true);
  assert.match(doc.querySelector("input.combo-input").value, /12345/);
  assert.equal(doc.querySelectorAll(".combo-modal").length, 0, "dialog closed after choosing");

  const r = await a.readBalance(acct);
  assert.ok(r.confidence >= 0.9, `confidence ${r.confidence}`);
  assert.equal(r.value.balance, 50000);
});

test("new site: no matching row closes the picker instead of leaving it open", async () => {
  const doc = newSiteForm({ rows: ["000000077777 別的帳戶"] });
  const a = new EsunAdapter({ root: doc, config });

  const ok = await a.selectSourceAccount({ id: "s1", accountLast5: "12345", label: "零用金" });
  assert.equal(ok, false, "reports failure rather than picking something else");
  assert.equal(doc.querySelectorAll(".combo-modal").length, 0, "dialog must not be left covering the form");
});

test("new site: 下一步 is matched by text, and 立即交易 is refused", async () => {
  // Both buttons carry btn-main-fill on the real site, which is why the adapter
  // matches on text. If it ever matched the class, this is the transfer it
  // would execute.
  const doc = loadDom(
    `<!DOCTYPE html><html><body><input class="combo-input">
       <button class="btn-main-fill">立即交易</button>
     </body></html>`,
    CONFIRM_URL,
  );
  const a = new EsunAdapter({ root: doc, config });
  let clicked = false;
  doc.querySelector("button").addEventListener("click", () => { clicked = true; });

  await a.submitFormToVerificationPage();
  assert.equal(clicked, false, "must never press 立即交易");

  // And the guard refuses even a direct attempt.
  assert.throws(() => a._click(doc.querySelector("button")), /forbidden/);
});

test("new site: a real result page reads as completed, with no invented reference", () => {
  // Measured on a real transfer: the result page carries 轉帳金額, 轉入對象,
  // 轉出帳號, 轉帳日期 and the memos — and no transaction serial at all. The
  // long digit runs on it are the two account numbers.
  const doc = loadDom(
    `<!DOCTYPE html><html><body><input class="combo-input">
       <div>交易成功</div>
       <div class="info-header">轉帳金額</div><div>1</div>
       <div class="info-header">轉入對象</div><div>張○欽 玉山銀行 0531234567648</div>
       <div class="info-header">轉出帳號</div><div>零用金 0531234567647 可用餘額 TWD 50,000</div>
       <div class="info-header">轉帳日期</div><div>2026/10/17</div>
       <button class="btn-footer-border">再轉一筆</button>
     </body></html>`,
    "https://ebank.esunbank.com.tw/esb/deposit/twd-transfer/result",
  );
  const r = new EsunAdapter({ root: doc, config }).readCompletion();
  assert.equal(r.value.completed, true);
  assert.ok(r.confidence >= 0.9, `confidence ${r.confidence}`);
  assert.equal(
    r.value.bankReferenceMasked,
    undefined,
    "the page has no serial; an account number must never be filed as one",
  );
});

test("new site: success wording without the result rows is not a completed transfer", () => {
  const doc = loadDom(
    `<!DOCTYPE html><html><body><input class="combo-input">交易成功</body></html>`,
    "https://ebank.esunbank.com.tw/esb/deposit/twd-transfer/result",
  );
  const r = new EsunAdapter({ root: doc, config }).readCompletion();
  assert.ok(r.confidence < 0.9, "wording alone must not read as proof");
  assert.equal(r.value, null);
});

test("new site: 再轉一筆 returns to the form for the next job", async () => {
  const doc = loadDom(
    `<!DOCTYPE html><html><body><input class="combo-input">
       <div>交易成功</div>
       <button class="btn-footer-border">再轉一筆</button>
     </body></html>`,
    "https://ebank.esunbank.com.tw/esb/deposit/twd-transfer/result",
  );
  let clicked = false;
  doc.querySelector("button").addEventListener("click", () => { clicked = true; });
  await new EsunAdapter({ root: doc, config }).navigateToNextTransfer();
  assert.equal(clicked, true);
});

// The balance on screen belongs to whichever account the form has selected, and
// nothing in the markup ties the two together.
test("new site: balance is read after its label, not as the first number", async () => {
  const doc = newSiteForm();
  const a = new EsunAdapter({ root: doc, config });
  const acct = { id: "s1", accountLast5: "12345", label: "零用金" };
  await a.selectSourceAccount(acct);

  // The fixture renders the balance beside the account, as the result step does.
  doc.getElementById("bal").innerHTML =
    "<div>零用金 0531234567647 可用餘額 TWD 50,000</div>";

  const r = await a.readBalance(acct);
  assert.equal(r.value.balance, 50000, "must not return the account number");
});

test("new site: a balance that cannot be attributed to the account is refused", async () => {
  // Measured during a real batch: the reader answered 238ms after the batch
  // began — before any source had been chosen — and reported a figure that was
  // not this account's. A wrong balance is the input to the check that decides
  // whether the batch may proceed, so an unattributable one must be no answer
  // rather than a plausible one.
  const doc = newSiteForm({ rows: ["000000099999 別的帳戶"] });
  const a = new EsunAdapter({ root: doc, config });
  doc.getElementById("bal").innerHTML = "<div><span>可用餘額</span><span>999,999</span></div>";

  const r = await a.readBalance({ id: "s1", accountLast5: "12345", label: "零用金" });
  assert.equal(r.value, null, "a figure on screen is not this account's balance");
  assert.equal(r.confidence, 0);
  assert.ok(
    r.missingFields.join().includes("source"),
    `should say the source could not be confirmed, got ${r.missingFields.join()}`,
  );
});

test("new site: the payee list is behind a tab the dialog does not open on", async () => {
  // The dialog opens on 常用帳號, which holds a different and much shorter list
  // than the designated accounts a batch transfers to. Measured on the live
  // site: one row on the default tab, ten on 約定帳號.
  const doc = loadDom(
    `<!DOCTYPE html><html><body>
       <input class="combo-input" readonly placeholder="請選擇轉入帳號">
       <label><input type="radio">常用/約定帳號</label>
       <div id="host"></div>
     </body></html>`,
    EDIT_URL,
  );
  const trigger = doc.querySelector("input.combo-input");
  const host = doc.getElementById("host");
  const render = (tab) => {
    host.innerHTML = `
      <div class="combo-modal" role="dialog">
        <div class="modal-header"><button class="toggle" aria-label="關閉"></button></div>
        <div><div role="tab" class="${tab === "common" ? "selected" : ""}">常用帳號</div>
             <div role="tab" class="${tab === "designated" ? "selected" : ""}">約定帳號</div></div>
        <ul>${(tab === "designated"
                ? ["玉山銀行 0000000012345", "兆豐銀行 0000000099999"]
                : ["台新銀行 0000000077777"]
              ).map((r) => `<li role="button">${r}</li>`).join("")}</ul>
      </div>`;
    for (const t of doc.querySelectorAll("[role=tab]")) {
      t.addEventListener("click", () => render(t.textContent.includes("約定") ? "designated" : "common"));
    }
    for (const li of doc.querySelectorAll(".combo-modal li")) {
      li.addEventListener("click", () => { trigger.value = li.textContent; host.innerHTML = ""; });
    }
    const close = doc.querySelector(".combo-modal button[aria-label='關閉']");
    if (close) close.addEventListener("click", () => { host.innerHTML = ""; });
  };
  trigger.addEventListener("click", () => render("common"));

  const a = new EsunAdapter({ root: doc, config });
  // The payee exists only on the designated tab.
  const ok = await a.selectDestinationPayee({ id: "p1", accountLast5: "12345" });
  assert.equal(ok, true, "must switch tabs to find a designated payee");
  assert.match(trigger.value, /12345/);
});

test("new site: a swallowed first click on the picker is retried", async () => {
  // Measured on the live site: choosing the designated radio leaves the
  // component re-initialising and the next click does nothing at all — same
  // node, no dialog, and waiting does not help. Only a second click opens it.
  const doc = loadDom(
    `<!DOCTYPE html><html><body>
       <input class="combo-input" readonly placeholder="請選擇轉出帳號">
       <div id="host"></div>
     </body></html>`,
    EDIT_URL,
  );
  const trigger = doc.querySelector("input.combo-input");
  const host = doc.getElementById("host");
  let clicks = 0;
  trigger.addEventListener("click", () => {
    if (++clicks < 2) return; // the first one is eaten, exactly as observed
    host.innerHTML = `
      <div class="combo-modal" role="dialog">
        <div class="modal-header"><button class="toggle" aria-label="關閉"></button></div>
        <ul><li role="button">000000012345 零用金</li></ul>
      </div>`;
    doc.querySelector(".combo-modal li").addEventListener("click", () => {
      trigger.value = "000000012345 零用金";
      host.innerHTML = "";
    });
  });

  const a = new EsunAdapter({ root: doc, config });
  const ok = await a.selectSourceAccount({ id: "s1", accountLast5: "12345" });
  assert.equal(ok, true, "one dead click must not read as 'there is no picker'");
  assert.ok(clicks >= 2, `expected a retry, saw ${clicks} click(s)`);
});

test("new site: the confirm step is read from its real layout", () => {
  // Copied from the live 資料確認 step. Two traps are deliberate here:
  // 轉入對象別名 holds the nickname and contains the string 轉入對象, and the
  // 轉帳金額 item holds only its label, with the amount as the item's sibling.
  const doc = loadDom(
    `<!DOCTYPE html><html><body><input class="combo-input">
       <div>
         <div class="txn-data-item"><div class="info-header">轉帳金額</div></div>
         <div>TWD 1</div>
         <div class="txn-data-item"><div class="info-header">轉入對象別名</div><div>動產臨時支出準備金</div></div>
         <div class="txn-data-item"><div class="info-header">轉入對象</div><div>張○欽 玉山銀行 0531234567648</div></div>
         <div class="txn-data-item"><div class="info-header">轉出帳號</div><div>0531234567647 零用金</div></div>
         <div class="txn-data-item"><div class="info-header">備註給自己</div><div>-</div></div>
         <div class="txn-data-item"><div class="info-header">備註給對方</div><div>記號</div></div>
       </div>
     </body></html>`,
    "https://ebank.esunbank.com.tw/esb/deposit/twd-transfer/confirm",
  );
  const r = new EsunAdapter({ root: doc, config }).readVerificationSummary();

  assert.equal(r.value.amount, 1, "the amount is a sibling of its item, not a child");
  assert.equal(r.value.destinationAccountLast5, "67648", "must read 轉入對象, not 轉入對象別名");
  assert.equal(r.value.sourceAccountLast5, "67647");
  assert.equal(r.value.memoShort, undefined, "an empty memo renders as - and means empty");
  assert.equal(r.value.memoLong, "記號");
  assert.ok(r.confidence >= 0.99, `confidence ${r.confidence}`);
});
