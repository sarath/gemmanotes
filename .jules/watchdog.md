## 2026-08-11 - Replaced navigator with activeWindow.navigator
**Learning:** In Obsidian plugins, using the global `navigator` object for hardware/browser APIs (like clipboard, media devices, and WebGPU) can lead to NotAllowedError exceptions when the plugin is invoked from a popout window where the main window lacks focus.
**Action:** Always use `activeWindow.navigator` instead to ensure correct window context execution.
