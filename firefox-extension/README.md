# Auto Flow Firefox Extension

This folder is the Firefox WebExtensions build of Auto Flow.

## Load for Testing

1. Open Firefox.
2. Go to `about:debugging#/runtime/this-firefox`.
3. Click `Load Temporary Add-on...`.
4. Select `firefox-extension/manifest.json`.
5. Open the Auto Flow sidebar from Firefox's sidebar/extensions UI.

## Notes

- The Chrome `side_panel` entry is replaced by Firefox `sidebar_action`.
- The background entry uses Firefox-compatible `background.scripts`.
- `src/firefox/compat.js` only aliases `browser.*` to `chrome.*` when `chrome` is not present.
- Firefox does not provide Chrome's `chrome.debugger` API. DOM debugger submit paths may report debugger unavailable; API submit paths should be preferred.
- Keep this folder separate from the Chrome root extension so both builds can be tested independently.
