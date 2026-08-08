## 2024-05-24 - activeWindow is a global, not an export
**Learning:** In Obsidian plugins, `activeWindow` and `activeDocument` are global variables defined in `obsidian.d.ts` (using `declare let activeWindow: Window;`). Trying to explicitly import them via `import { activeWindow } from "obsidian";` will result in a `Cannot find name 'activeWindow'` TypeScript compilation error (TS2305).
**Action:** Always use `activeWindow` and `activeDocument` globally as they are implicitly available.
