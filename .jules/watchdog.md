## 2024-11-20 - Unreachable Code Cleanup
**Learning:** A dangling `this.loadPromise = null;` after a return statement in `getCacheDir()` triggered unreachable code errors.
**Action:** Remove unreachable code, run strict TypeScript checks to identify them in the future.
## 2024-11-20 - activeDocument vs document
**Learning:** Obsidian linting (`eslint-plugin-obsidianmd`) explicitly requires using `activeDocument` instead of `document` for popout window compatibility. Reverting `activeDocument` to `document` caused warning `obsidianmd/prefer-active-doc`.
**Action:** Always stick with `activeDocument` in Obsidian plugins if dealing with DOM to maintain multi-window support.
## 2024-11-20 - Ensure Memory/Resource Cleanup in Transcriber Queue and Editor Effects**Learning:** The existing codebase handles cleanup explicitly in most places, like queue pumping with finally and clearing timeouts.**Action:** Re-verify all edge cases handle resource cleanup
## 2024-11-20 - Ensure Memory/Resource Cleanup in Transcriber Queue and Editor Effects
**Learning:** The existing codebase handles cleanup explicitly in most places, like queue pumping with finally and clearing timeouts.
