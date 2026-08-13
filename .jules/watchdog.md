## 2024-05-24 - Replace global navigator with activeWindow.navigator
**Learning:** Using the global `navigator` object in Obsidian plugins can cause `NotAllowedError` exceptions in popout windows where the main window lacks focus.
**Action:** Always use `activeWindow.navigator` instead of the global `navigator` object when using APIs like `clipboard.writeText` and `mediaDevices.getUserMedia`.
