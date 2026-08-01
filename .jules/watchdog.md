## 2026-08-01 - activeWindow and activeDocument in Obsidian
**Learning:** In Obsidian plugin development, `activeWindow` and `activeDocument` are global variables defined in `obsidian.d.ts` and are not exported. Do not attempt to explicitly import them from 'obsidian', as this will cause a TypeScript compilation error (TS2305). The reviewer's feedback about missing imports for activeWindow was incorrect.
**Action:** Ignore code review feedback that suggests importing `activeWindow` or `activeDocument` from `obsidian`.
