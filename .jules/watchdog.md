## 2024-05-25 - activeWindow import in Obsidian
**Learning:** `activeWindow` and `activeDocument` are global variables injected by the Obsidian plugin environment, not named exports from the `obsidian` module. Importing them explicitly causes a TypeScript module resolution error.
**Action:** Use `activeWindow` and `activeDocument` as globals directly without importing them.
