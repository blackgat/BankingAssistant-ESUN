# Banking Assistant Browser Extension Spec v0.1

> 交付對象：Claude / coding agent
>
> 目標：實作一個只在嘉欽本機電腦瀏覽器上執行的銀行轉帳輔助 Browser Extension。使用者本人登入銀行網站、處理驗證、確認交易與授權。AI/extension 可協助檢查餘額、填寫既定欄位、偵測頁面狀態、循環處理多筆轉帳、最後提示餘額與協助登出。

---

## 1. 核心安全邊界

### 1.1 必守原則

- Extension / AI **不得保存或處理**：
  - 銀行登入密碼
  - OTP / 簡訊驗證碼
  - 行動銀行 push approval
  - 完整帳號
  - session token / CSRF token / hidden raw DOM
- 使用者本人負責：
  - 登入網站
  - 處理 2FA / OTP / 行動驗證
  - 在銀行驗證頁面確認交易
  - 最終授權交易
- Extension 可做：
  - 檢查指定來源帳戶餘額是否充足
  - 從銀行既有約定帳戶清單中選擇目的帳戶
  - 輸入金額
  - 輸入短備註
  - 輸入長備註
  - 偵測驗證頁 / 完成頁
  - 完成頁後進入下一筆轉帳
  - 迴圈結束後提示指定帳戶目前餘額
  - 協助點擊登出，若登出行為需要確認，須停下給使用者確認

### 1.2 最終確認規則

Extension 可以把流程推進到銀行的「驗證 / 確認頁」，但在該頁必須停下並等待使用者。

Extension 不得自動：

- 輸入 OTP
- 按下最終交易確認
- 繞過銀行驗證頁
- 在未觀測到使用者確認後假設交易成功

### 1.3 使用者確認完成的偵測方式

完成一筆交易的唯一可靠條件：

```text
Extension 偵測到銀行交易完成頁面
```

不得僅因為「送出按鈕被點擊」或「等待 N 秒」就認定完成。

---

## 2. 需求摘要

使用者預期流程：

```text
我登入網站
AI 檢查特定帳戶餘額是否充足
進入轉帳迴圈
 - 選取來源帳戶
 - 選取約定目的帳戶
 - 輸入金額
 - 輸入備註 短
 - 輸入備註 長
 - 等待使用者確定，通過驗證頁面
 - 偵測到完成頁面進入下一筆轉帳
迴圈結束
提示目前特定帳戶餘額
登出網站
```

---

## 3. 建議技術選型

### 3.1 Browser Extension

- Chrome / Edge：Manifest V3
- Safari 可後續移植，不列入 v0.1 必要範圍
- 初版只支援指定銀行網域，不要使用 `<all_urls>`

### 3.2 Extension 架構

```text
banking-assistant-extension/
  manifest.json
  src/
    background/
      service-worker.js
    content/
      main.js
      overlay.js
      state-machine.js
      extractors/
        bank-adapter.example.js
      actions/
        transfer-form-actions.js
    core/
      types.js
      policy.js
      allowlist.js
      sanitizer.js
      logger.js
    options/
      options.html
      options.js
      options.css
  tests/
    policy.test.js
    sanitizer.test.js
    state-machine.test.js
  SPEC.md
```

### 3.3 權限原則

Manifest 必須最小權限：

```json
{
  "manifest_version": 3,
  "name": "Banking Transfer Assistant",
  "version": "0.1.0",
  "permissions": ["storage", "activeTab"],
  "host_permissions": ["https://YOUR_BANK_DOMAIN.example/*"],
  "content_scripts": [
    {
      "matches": ["https://YOUR_BANK_DOMAIN.example/*"],
      "js": ["src/content/main.js"],
      "run_at": "document_idle"
    }
  ],
  "background": {
    "service_worker": "src/background/service-worker.js"
  },
  "options_page": "src/options/options.html"
}
```

若銀行頁面使用 iframe，才加入：

```json
"all_frames": true
```

但加入前必須實測，並在 spec / README 記錄原因。

---

## 4. 資料模型

## 4.1 設定檔 `AssistantConfig`

```ts
type AssistantConfig = {
  bankId: string;
  bankOrigin: string;
  sourceAccounts: SourceAccount[];
  destinationPayees: DestinationPayee[];
  globalLimits: GlobalLimits;
  behavior: BehaviorConfig;
};
```

## 4.2 來源帳戶 `SourceAccount`

不可保存完整帳號。使用銀行頁面顯示名稱、遮罩帳號或末碼作辨識。

```ts
type SourceAccount = {
  id: string;
  label: string;
  displayNamePattern: string;
  accountLast5?: string;
  currency: "TWD";
  minimumRemainingBalance: number;
};
```

範例：

```json
{
  "id": "low_balance_transfer_account",
  "label": "低餘額轉帳專用帳戶",
  "displayNamePattern": "活期存款*12345",
  "accountLast5": "12345",
  "currency": "TWD",
  "minimumRemainingBalance": 1000
}
```

## 4.3 約定目的帳戶 `DestinationPayee`

只允許從銀行既有約定帳戶清單選取。

```ts
type DestinationPayee = {
  id: string;
  label: string;
  displayNamePattern: string;
  accountLast5?: string;
  currency: "TWD";
  maxAmountPerTxn: number;
  maxAmountPerDay?: number;
};
```

範例：

```json
{
  "id": "family_support",
  "label": "家用",
  "displayNamePattern": "張*67890",
  "accountLast5": "67890",
  "currency": "TWD",
  "maxAmountPerTxn": 10000,
  "maxAmountPerDay": 10000
}
```

## 4.4 轉帳任務 `TransferJob`

```ts
type TransferJob = {
  id: string;
  sourceAccountId: string;
  destinationPayeeId: string;
  amount: number;
  currency: "TWD";
  memoShort: string;
  memoLong: string;
  expectedDate?: string;
};
```

## 4.5 批次轉帳 `TransferBatch`

```ts
type TransferBatch = {
  batchId: string;
  createdAt: string;
  jobs: TransferJob[];
};
```

## 4.6 交易結果 `TransferResult`

```ts
type TransferResult = {
  jobId: string;
  status: "completed" | "failed" | "skipped" | "user_cancelled";
  completedAt?: string;
  bankReferenceMasked?: string;
  observedCompletionText?: string;
  error?: string;
};
```

## 4.7 Audit Log

儲存在 extension local storage 或下載成 JSONL。不要包含完整帳號、OTP、密碼、raw DOM。

```ts
type AuditLogEntry = {
  eventId: string;
  timestamp: string;
  eventType:
    | "batch_started"
    | "balance_checked"
    | "job_started"
    | "form_filled"
    | "waiting_user_verification"
    | "completion_detected"
    | "job_completed"
    | "job_failed"
    | "batch_completed"
    | "logout_clicked";
  jobId?: string;
  sourceAccountId?: string;
  destinationPayeeId?: string;
  amount?: number;
  currency?: "TWD";
  message: string;
};
```

---

## 5. 狀態機

## 5.1 Batch-level states

```text
IDLE
  -> USER_LOGGED_IN_DETECTED
  -> BALANCE_CHECKED
  -> BATCH_RUNNING
  -> BATCH_COMPLETED
  -> FINAL_BALANCE_DISPLAYED
  -> LOGGED_OUT_OR_LOGOUT_REQUESTED
```

## 5.2 Job-level states

```text
JOB_PENDING
  -> JOB_STARTED
  -> SOURCE_SELECTED
  -> DESTINATION_SELECTED
  -> AMOUNT_FILLED
  -> MEMO_SHORT_FILLED
  -> MEMO_LONG_FILLED
  -> FORM_READY_FOR_USER_REVIEW
  -> WAITING_USER_VERIFICATION
  -> COMPLETION_DETECTED
  -> JOB_COMPLETED
```

Failure / interruption states:

```text
JOB_FAILED
JOB_SKIPPED
USER_CANCELLED
AMBIGUOUS_PAGE_STATE
POLICY_BLOCKED
```

## 5.3 禁止狀態轉移

```text
WAITING_USER_VERIFICATION -> click final confirm by extension  // forbidden
FORM_READY_FOR_USER_REVIEW -> assume completed                 // forbidden
JOB_STARTED -> COMPLETION_DETECTED without completion page      // forbidden
```

---

## 6. 頁面辨識 Adapter

每家銀行需要一個 adapter，負責 DOM selector 與頁面判斷。初版只做一家銀行。

```ts
interface BankAdapter {
  bankId: string;

  detectLoginState(): "logged_in" | "logged_out" | "unknown";

  detectPageState():
    | "home"
    | "transfer_form"
    | "verification"
    | "completion"
    | "logout_confirm"
    | "unknown";

  extractSourceAccounts(): ObservedAccount[];
  extractCurrentBalance(sourceAccountId: string): BalanceObservation | null;
  extractDestinationPayees(): ObservedPayee[];

  selectSourceAccount(sourceAccount: SourceAccount): Promise<ActionResult>;
  selectDestinationPayee(payee: DestinationPayee): Promise<ActionResult>;
  fillAmount(amount: number): Promise<ActionResult>;
  fillMemoShort(memo: string): Promise<ActionResult>;
  fillMemoLong(memo: string): Promise<ActionResult>;

  navigateToTransferForm(): Promise<ActionResult>;
  submitFormToVerificationPage(): Promise<ActionResult>;

  extractVerificationSummary(): VerificationSummary | null;
  extractCompletionResult(): CompletionResult | null;

  navigateToNextTransfer(): Promise<ActionResult>;
  readFinalBalance(sourceAccount: SourceAccount): Promise<BalanceObservation | null>;
  logout(): Promise<ActionResult>;
}
```

## 6.1 Observed types

```ts
type ObservedAccount = {
  displayName: string;
  accountLast5?: string;
  currency: "TWD";
  balance?: number;
};

type BalanceObservation = {
  sourceAccountId?: string;
  displayName: string;
  accountLast5?: string;
  balance: number;
  currency: "TWD";
  observedAt: string;
};

type ObservedPayee = {
  displayName: string;
  accountLast5?: string;
  currency: "TWD";
};

type VerificationSummary = {
  sourceAccountLast5?: string;
  destinationPayeeNameMasked: string;
  destinationAccountLast5?: string;
  amount: number;
  currency: "TWD";
  memoShort?: string;
  memoLong?: string;
  pageState: "verification";
};

type CompletionResult = {
  pageState: "completion";
  bankReferenceMasked?: string;
  completionText: string;
  completedAt: string;
};

type ActionResult = {
  ok: boolean;
  message: string;
};
```

---

## 7. Policy Engine

Policy engine 必須 deterministic，不可呼叫 LLM 才決定是否繼續。

## 7.1 Batch pre-check

在進入迴圈前：

- 所有 job 的 sourceAccountId 必須存在
- 所有 job 的 destinationPayeeId 必須存在
- 所有 amount 必須 > 0
- 所有 amount 必須 <= destinationPayee.maxAmountPerTxn
- 同一批總額 + minimumRemainingBalance 不可超過目前餘額
- currency 必須為 TWD
- memoShort / memoLong 長度不可超過銀行欄位上限

```ts
type BatchPolicyResult = {
  result: "pass" | "fail";
  totalAmount: number;
  requiredMinimumBalance: number;
  observedBalance?: number;
  checks: PolicyCheck[];
};
```

## 7.2 Per-job policy

每一筆填表前檢查：

- source account match
- destination payee match
- amount under limit
- daily amount under limit if configured
- memo lengths valid

## 7.3 Verification page policy

在驗證頁停下前檢查：

- 驗證頁收款人與 expected payee match
- 驗證頁目的帳號末碼 match
- 驗證頁金額 match
- 驗證頁來源帳戶 match
- memo short / long match, 若銀行頁面有顯示

若任何不符：

- 顯示紅色 overlay
- 停止 batch
- 不進入下一筆

```ts
type PolicyCheck = {
  name: string;
  pass: boolean;
  detail: string;
};
```

---

## 8. UI / Overlay 需求

Extension 應提供固定 overlay，顯示：

- 目前 batch 狀態
- 第幾筆 / 共幾筆
- 來源帳戶 label
- 目的帳戶 label
- 金額
- policy check 結果
- 下一步需要使用者做什麼

## 8.1 等待使用者驗證畫面

在銀行驗證頁時 overlay 顯示：

```text
第 2 / 5 筆轉帳已填寫完成

請嘉欽本人在銀行驗證頁確認：
- 來源帳戶：低餘額轉帳專用帳戶 ****12345
- 目的帳戶：家用 ****67890
- 金額：NT$ 3,000
- 短備註：...
- 長備註：...

Extension 正在等待交易完成頁。
請你完成銀行要求的驗證/確認。
```

## 8.2 完成頁偵測

偵測到完成頁後 overlay 顯示：

```text
第 2 / 5 筆完成
交易參考：ABC****789
準備進入下一筆...
```

## 8.3 錯誤頁 / 不明頁

```text
無法確認目前頁面狀態，已停止批次。
請不要繼續自動流程。
原因：expected verification page, got unknown.
```

---

## 9. 主流程演算法

```ts
async function runTransferBatch(batch: TransferBatch, config: AssistantConfig) {
  assertUserLoggedIn();

  const source = getPrimarySourceAccountForBatch(batch, config);
  const balance = await adapter.extractCurrentBalance(source.id);
  const precheck = evaluateBatchPolicy(batch, config, balance);

  if (precheck.result !== "pass") {
    overlay.showPolicyFailure(precheck);
    audit("batch_blocked", precheck);
    return;
  }

  overlay.showBalanceChecked(balance, precheck);

  for (const job of batch.jobs) {
    const jobPolicy = evaluateJobPolicy(job, config);
    if (jobPolicy.result !== "pass") {
      overlay.showJobSkipped(job, jobPolicy);
      audit("job_skipped", { job, jobPolicy });
      continue;
    }

    audit("job_started", { jobId: job.id });

    await adapter.navigateToTransferForm();
    await adapter.selectSourceAccount(getSourceAccount(job.sourceAccountId));
    await adapter.selectDestinationPayee(getPayee(job.destinationPayeeId));
    await adapter.fillAmount(job.amount);
    await adapter.fillMemoShort(job.memoShort);
    await adapter.fillMemoLong(job.memoLong);

    // This may navigate to verification page, but must not complete final transfer.
    await adapter.submitFormToVerificationPage();

    const verification = await waitForVerificationPage();
    const verificationPolicy = evaluateVerificationPolicy(job, config, verification);

    if (verificationPolicy.result !== "pass") {
      overlay.showPolicyFailure(verificationPolicy);
      audit("job_failed", { jobId: job.id, verificationPolicy });
      stopBatch();
      return;
    }

    overlay.showWaitingUserVerification(job, verificationPolicy);
    audit("waiting_user_verification", { jobId: job.id });

    const completion = await waitForCompletionPageOrUserCancel();
    if (!completion) {
      overlay.showUserCancelledOrTimeout(job);
      audit("job_cancelled_or_timeout", { jobId: job.id });
      stopBatch();
      return;
    }

    audit("completion_detected", { jobId: job.id, completion });
    overlay.showJobCompleted(job, completion);

    await adapter.navigateToNextTransfer();
  }

  const finalBalance = await adapter.readFinalBalance(source);
  overlay.showBatchCompleted(finalBalance);
  audit("batch_completed", { finalBalance });

  await adapter.logout();
  audit("logout_clicked", {});
}
```

---

## 10. 等待與超時規則

### 10.1 等待驗證頁

```text
submit form 後最多等待 30 秒進入 verification page
超時：停止 batch，提示使用者
```

### 10.2 等待完成頁

```text
verification page 後最多等待使用者 5 分鐘
期間不自動點擊任何確認按鈕
若偵測 completion page，進下一筆
若偵測 error page，停止
若使用者按 cancel，停止
```

此 timeout 可在 options 設定。

---

## 11. Selector 與 Confidence

銀行 DOM adapter 不可只靠單一 fragile selector。建議 extractor 回傳 confidence：

```ts
type ExtractionResult<T> = {
  value: T | null;
  confidence: number;
  missingFields: string[];
};
```

門檻：

```text
confidence >= 0.9 才允許通過 policy
低於 0.9 停止並要求人工處理
```

Selector 策略：

1. 明確 DOM selector
2. label-neighbor text extraction
3. regex from visible text
4. 若結果不一致，fail closed

---

## 12. 敏感資料處理

## 12.1 Sanitizer

任何輸出到 overlay、audit log、Hermes、console 前都必須 sanitize。

規則：

- 完整帳號只保留末 5 碼
- 金融卡號 / 信用卡號不得保存
- 身分證字號不得保存
- raw DOM 不得保存
- hidden input value 不得保存

```ts
function sanitizeAccount(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.length <= 5 ? digits : `****${digits.slice(-5)}`;
}
```

## 12.2 Console log

Production extension 不得 `console.log` raw page text / raw DOM / full extracted values。

---

## 13. Hermes 整合，v0.1 可選

v0.1 可以先不整合 Hermes，只做本機 deterministic assistant。

若要整合 Hermes，必須只傳 sanitized summary：

```json
{
  "task": "review_transfer_batch_progress",
  "job": {
    "destinationPayeeId": "family_support",
    "amount": 3000,
    "currency": "TWD",
    "memoShort": "家用",
    "memoLong": "2026-06 家用"
  },
  "verificationSummary": {
    "sourceAccountLast5": "12345",
    "destinationAccountLast5": "67890",
    "amount": 3000,
    "currency": "TWD"
  },
  "localPolicyResult": "pass"
}
```

Hermes 不得回傳或控制：

```json
{
  "clickFinalConfirm": true
}
```

程式碼層面不要定義這種 action。

---

## 14. Options Page 需求

Options page 應可設定：

- bank domain
- source accounts
- destination payees
- global timeout
- memo field max length
- export config JSON
- import config JSON
- clear audit log

Options page 不得要求或保存：

- 銀行登入帳密
- OTP seed
- 完整帳號

---

## 15. 測試需求

### 15.1 Unit tests

必須測：

- policy pass
- amount exceeds max fail
- payee mismatch fail
- source account mismatch fail
- insufficient balance fail
- memo too long fail
- sanitizer masks account
- state machine forbids agent final submit

### 15.2 DOM fixture tests

建立 HTML fixtures：

```text
tests/fixtures/bank-home.html
tests/fixtures/transfer-form.html
tests/fixtures/verification.html
tests/fixtures/completion.html
tests/fixtures/error.html
```

測 adapter：

- detectPageState
- extract balance
- extract payee list
- fill form fields
- extract verification summary
- extract completion result

### 15.3 Manual QA checklist

- [ ] Extension 只在銀行網域啟用
- [ ] 未登入時不做任何操作
- [ ] 餘額不足時停止
- [ ] 金額超限時停止
- [ ] payee 不在白名單時停止
- [ ] verification page 停下等待使用者
- [ ] 使用者完成驗證後，completion page 被偵測
- [ ] 多筆轉帳可進入下一筆
- [ ] batch 結束後顯示 final balance
- [ ] logout 被觸發或提示使用者登出
- [ ] audit log 不含完整帳號 / 密碼 / OTP / raw DOM

---

## 16. Fail-closed 規則

遇到以下情況必須停止 batch：

- 不明頁面狀態
- 多個 source account 可能匹配
- 多個 destination payee 可能匹配
- balance 讀取失敗
- verification summary 與 job 不一致
- completion page 偵測不明確
- selector confidence < 0.9
- extension context reload
- 使用者切換頁面或登出
- 銀行跳出錯誤訊息

---

## 17. README 需明確寫入的限制

README 必須寫：

```text
This extension is a local banking transfer assistant.
It does not store bank passwords, OTPs, or full account numbers.
It does not click the final transfer confirmation button.
The user must manually authorize every transfer on the bank verification page.
```

繁中版：

```text
本 extension 僅為本機銀行轉帳輔助工具。
它不保存銀行密碼、OTP 或完整帳號。
它不會點擊最終轉帳確認按鈕。
每一筆轉帳都必須由使用者本人在銀行驗證頁手動授權。
```

---

## 18. v0.1 實作範圍

### 必須完成

- Manifest V3 extension skeleton
- Options page config
- One bank adapter placeholder
- Source account balance extraction placeholder
- Destination payee selection placeholder
- Transfer form filling placeholder
- Verification page detection
- Completion page detection
- Deterministic policy engine
- Overlay UI
- Audit log
- Unit tests for policy/sanitizer/state machine

### 不做

- 不做跨銀行通用 adapter
- 不做 OTP handling
- 不做 password manager integration
- 不做 final submit click
- 不做 cloud sync
- 不做 raw DOM upload

---

## 19. Claude 實作指示

請 Claude 依照此 spec 產出一個可安裝的 Chrome Manifest V3 extension MVP。

要求：

1. 使用 TypeScript 或 plain JavaScript 均可；若沒有 build system，plain JavaScript 優先。
2. 所有 bank-specific selector 集中在 `bank-adapter.example.js`。
3. `policy.js` 與 `sanitizer.js` 必須可單元測試。
4. 所有 sensitive data output 前都要經過 sanitizer。
5. 不可實作 final confirm click action。
6. 不可要求或保存銀行密碼 / OTP。
7. 預設 bank domain 使用 placeholder：`https://YOUR_BANK_DOMAIN.example/*`。
8. README 要說明如何在 Chrome `chrome://extensions` load unpacked。
9. README 要說明如何替換銀行 selector。
10. 提供 fixtures 與測試。

---

## 20. 驗收標準

完成後應能：

1. 在 Chrome load unpacked extension。
2. 在 fixture transfer form 中模擬批次轉帳流程。
3. 顯示餘額檢查結果。
4. 對每筆 job 填入來源帳戶、目的帳戶、金額、短備註、長備註。
5. 到 verification fixture 時停止並顯示等待使用者確認。
6. 切換到 completion fixture 後自動進下一筆。
7. 全部完成後顯示 final balance。
8. 寫入 audit log。
9. 測試證明 extension 沒有 final confirm click action。
10. audit log 不含完整帳號、OTP、密碼、raw DOM。
