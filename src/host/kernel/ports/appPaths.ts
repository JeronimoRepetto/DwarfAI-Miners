// Kernel driven port (05 §3, 16 §3; AMENDMENT-10, OQ-78): values fixed for the Host's life.
// `userDataDir` = DWARFAI_HOST_DATA_DIR, i.e. Electron userData + /host (ADR-002 D2); the log
// folder is its parent's logs/ (ADR-026 item 1).
export interface AppPaths {
  userDataDir: string
  execPath: string
  resourcesPath: string | null
  isPackaged: boolean
}
