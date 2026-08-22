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

test("readBalance opens the transfer form when it isn't showing, then reads 可用餘額", async () => {
  // A minimal E.SUN-shaped page: a dashboard with only the transfer menu link.
  // Clicking it swaps in a transfer form; choosing the source reveals 可用餘額,
  // mirroring the bank's AJAX behaviour.
  const doc = loadDom(`<!DOCTYPE html><html><body>
    <a class="log_out" href="#logout">登出</a>
    <div id="app"><a id="menu">即時 / 預約轉帳</a></div>
  </body></html>`);
  doc.getElementById("menu").addEventListener("click", () => {
    doc.getElementById("app").innerHTML = `
      <div class="step"><dt class="current">Step1資料編輯</dt></div>
      <form class="transfer-form">
        <dl><dt>轉出帳號</dt><dd>
          <select><option value="">請選擇</option><option value="s1">活期存款 ****12345</option></select>
        </dd></dl>
        <div id="bal"></div>
      </form>`;
    const sel = doc.querySelector("form select");
    sel.addEventListener("change", () => {
      if (sel.value) doc.getElementById("bal").innerHTML = `<span>可用餘額<br><span>50,000</span></span>`;
    });
  });

  const a = new EsunAdapter({ root: doc, config });
  assert.equal(a._controlByLabel(a.selectors.labels.source, "select"), null, "no form to begin with");

  const r = await a.readBalance(source);
  assert.ok(r.confidence >= 0.9, `confidence ${r.confidence}`);
  assert.equal(r.value.balance, 50000);
  assert.equal(r.value.sourceAccountId, source.id);
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
