## Watchdog's JOURNAL
## 2025-02-26 - activeWindow global vs import
**Learning:** In Obsidian plugin development, `activeWindow` and `activeDocument` are global variables defined in `obsidian.d.ts` and are not exported. The code review tool mistakenly flagged the usage of `activeWindow` as an error because it thought it needed to be imported from 'obsidian'. However, importing it causes a TypeScript compilation error (TS2305).
**Action:** Ignore hallucinated code review feedback about importing `activeWindow`. Rely on `npx tsc --noEmit` as the source of truth for TypeScript errors.
