// Classic content script (declared in manifest). Its only job is to load the
// real ESM entry point. Content scripts declared in the manifest are evaluated
// as classic scripts, so we dynamic-import the module form, which lets all of
// our code use ES modules and stay unit-testable. The imported files are listed
// in web_accessible_resources.

(async () => {
  try {
    const url = chrome.runtime.getURL("src/content/main.module.js");
    await import(url);
  } catch (e) {
    // Fail closed and never log raw page content.
    console.error("[BankingAssistant] bootstrap failed:", e && e.message);
  }
})();
