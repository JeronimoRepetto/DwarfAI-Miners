// What the Host runs on, for its `host.start` record (19 §9.1: "os, arch and runtime versions go in
// `msg` as fixed tokens"). Here because reading `process.platform` is OS knowledge (R18).

export interface HostRuntime {
  /** `win32`, `darwin` or `linux`. */
  os: string
  arch: string
  /** The Node version of the runtime (Electron's own Node under ELECTRON_RUN_AS_NODE). */
  node: string
  /** The Electron version when the Host runs on the app's executable; absent under plain Node. */
  electron?: string
}

export function hostRuntime(): HostRuntime {
  const electron = process.versions['electron']
  return {
    os: process.platform,
    arch: process.arch,
    node: process.versions.node,
    ...(electron === undefined ? {} : { electron })
  }
}
