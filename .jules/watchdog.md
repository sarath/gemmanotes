## 2024-05-20 - Obsidian Popout Compatibility
**Learning:** Using the global `navigator` object in Obsidian plugins causes exceptions (`NotAllowedError`) in popout windows where the main window lacks focus, affecting things like clipboard and mediaDevices APIs.
**Action:** Always use `activeWindow.navigator` instead of the global `navigator` object in Obsidian plugins for APIs like `clipboard.writeText`, `mediaDevices.getUserMedia`, and `gpu`.
