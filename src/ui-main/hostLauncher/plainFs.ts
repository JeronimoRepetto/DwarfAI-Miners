// The file system the Host's versioned copy works on (ADR-002 D5): Node's own `fs`, without Electron's asar layer.
//
// Inside Electron (UI main) `node:fs` reads an `.asar` archive as a folder. The runtime folder the copy is made from
// holds one (`resources/default_app.asar` in development, the app's own `app.asar` once packaged), so copying,
// hashing, checking or removing that folder through `node:fs` would go into the archive instead of treating it as
// the one file it is (`fs.cp` stops with "Invalid package", the copy fails COPY_FAILED). Electron's built-in
// `original-fs` is the same module without that layer. Plain Node has neither the layer nor `original-fs`: there it
// is `node:fs` itself.
//
// Node built-ins only and erasable TypeScript only, so the plain-Node build script reaches it through
// hostManifest.ts as it is (Node 24 strips the types).
import * as nodeFs from 'node:fs'
import { createRequire } from 'node:module'

export const plainFs: typeof nodeFs =
  process.versions.electron === undefined
    ? nodeFs
    : (createRequire(import.meta.url)('original-fs') as typeof nodeFs)
