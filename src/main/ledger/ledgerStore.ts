import { readFile, rename, writeFile } from 'node:fs/promises'
import { emptyLedger, parseLedger, serializeLedger, type LedgerState } from '../domain/ledger'

/**
 * The persisted material vault, see #22.
 *
 * Storage deliberately mirrors the pin and shortcut preferences
 * (src/main/pinPreference.ts, src/main/shortcutPreference.ts): one JSON
 * document under userData, rewritten atomically through a sibling temp file
 * plus a rename, with an injected fs so tests need no real disk and Electron
 * is never imported here — the wiring in src/main/index.ts owns the userData
 * path, keeping this module unit-testable without an app instance.
 *
 * What differs from those two is the stakes. A lost pin preference costs the
 * user one click; a torn ledger costs them every token this app has ever
 * watched them burn. Hence the same tmp+rename discipline, and a load() that
 * degrades to an empty vault rather than refusing to start.
 */

/** Sibling suffix for the atomic write; same directory keeps rename on one volume. */
const TEMP_SUFFIX = '.tmp'

export interface LedgerFsLike {
  readFile: (path: string, encoding: 'utf8') => Promise<string>
  writeFile: (path: string, data: string, encoding: 'utf8') => Promise<void>
  rename: (from: string, to: string) => Promise<void>
}

const realFs: LedgerFsLike = { readFile, writeFile, rename }

/**
 * Write `content` to `filePath` atomically: land it in a sibling temp file
 * first, then rename it onto the target.
 *
 * The sibling keeps the rename on one volume, which is what makes it atomic;
 * a crash mid-write can then only leave the previous intact file (or a stray
 * temp file) behind, never a torn one. Shared with the coal-backfill marker,
 * which needs exactly the same guarantee for the same reason.
 */
export async function writeFileAtomic(
  fs: LedgerFsLike,
  filePath: string,
  content: string
): Promise<void> {
  const tempPath = `${filePath}${TEMP_SUFFIX}`
  await fs.writeFile(tempPath, content, 'utf8')
  await fs.rename(tempPath, filePath)
}

export interface LedgerStore {
  /** The stored vault, or an empty one when there is none (or it is unreadable). */
  load: () => Promise<LedgerState>
  /** Persist atomically. Rejections are the caller's to handle. */
  save: (state: LedgerState) => Promise<void>
}

/**
 * A store that remembers nothing.
 *
 * The default when no userData path has been wired in: unit tests, and any
 * embedding of the runtime that has no business writing to disk. It keeps the
 * vault a working in-memory feature rather than making persistence a
 * precondition for the runtime starting at all.
 */
export function nullLedgerStore(): LedgerStore {
  return {
    load: async () => emptyLedger(),
    save: async () => undefined
  }
}

export interface LedgerStoreOptions {
  /** Full path of the ledger file (under userData in production). */
  filePath: string
  /** Injected for tests; defaults to the real filesystem. */
  fs?: LedgerFsLike
}

export function createLedgerStore(options: LedgerStoreOptions): LedgerStore {
  const fs = options.fs ?? realFs

  async function load(): Promise<LedgerState> {
    try {
      return parseLedger(await fs.readFile(options.filePath, 'utf8'))
    } catch {
      // Missing file is the common first-run case; any other read failure
      // (permissions, transient IO) is treated the same way, because the vault
      // is never worth failing startup over. parseLedger already turns corrupt
      // CONTENT into an empty vault; this catch is for an unreadable FILE.
      return emptyLedger()
    }
  }

  async function save(state: LedgerState): Promise<void> {
    await writeFileAtomic(fs, options.filePath, serializeLedger(state))
  }

  return { load, save }
}
