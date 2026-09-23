/**
 * Vite's `?raw` suffix, for the main process (#588 T6): the import resolves to
 * the file's own bytes as a string, untransformed. The renderer gets this
 * declaration from `vite/client`; main has no such types, and exactly one
 * main module needs it — the OpenCode plugin installer, which writes an
 * artifact's SOURCE to disk rather than running it.
 */
declare module '*?raw' {
  const source: string
  export default source
}
