(() => {
  if (typeof globalThis.browser === "undefined") return;
  if (typeof globalThis.chrome !== "undefined") return;
  try {
    globalThis.chrome = globalThis.browser;
  } catch {
    // Firefox exposes browser.* as the Promise-based WebExtensions API.
  }
})();
