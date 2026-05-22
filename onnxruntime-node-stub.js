/*
 * Build-time stub for `onnxruntime-node`.
 *
 * transformers.js statically imports `onnxruntime-node`, but its native
 * binding cannot load inside a bundled Obsidian plugin. GemmaNotes forces the
 * web runtime instead (see src/transcriber.ts), so this package is aliased to
 * an empty module to keep native code out of the bundle.
 */
export {};
