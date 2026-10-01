/**
 * Vite's `?raw` suffix for the Host (the build and the tests inline the file's bytes as a
 * string, untransformed): migrations import their SQL text this way (`0001-initial.sql?raw`), so
 * the text is part of the bundle and its checksum never depends on a file beside it at run time.
 * Declared here, beside the code that needs it, so the Host owns it; it merges with any identical
 * declaration elsewhere in the program.
 */
declare module '*?raw' {
  const source: string
  export default source
}
