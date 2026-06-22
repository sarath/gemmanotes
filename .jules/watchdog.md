## 2026-06-22 - Window vs activeWindow
**Learning:** `window.setInterval` and `window.setTimeout` are the preferred way to interact with timers according to eslint rule `obsidianmd/prefer-window-timers`. `activeWindow` should not be used for timers. `activeWindow` is correct for other DOM methods like `innerWidth`, `scrollX`, etc., in Obsidian plugins to support popout windows.
**Action:** Only replace DOM-related methods on `window` (like `innerWidth`, `getSelection`) with `activeWindow`, but keep using `window` for timer functions (`setInterval`, `setTimeout`, etc.).
