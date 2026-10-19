// The per-boot uiToken (ADR-003 item 3, frozen; AMENDMENT-10): the only credential of the UI
// endpoint.
//
// - `issue` makes 32 random bytes, writes them as lower-case hex to `<runDir>/ui.token` and keeps
//   only the SHA-256 of that hex in memory; the hex itself is dropped as soon as it is written.
// - The run directory is created `0700` (and narrowed to `0700` when it exists); the file is
//   created exclusively (`wx`) with mode `0600` after the previous boot's file is removed, so a link
//   planted at the path is replaced, never written through. On Windows the modes do nothing and the
//   file inherits the run directory's ACL (UNVERIFIED, SP-05).
// - `verify` hashes the candidate first and compares the two 32-byte digests with
//   `crypto.timingSafeEqual`, so a candidate of any length or alphabet is refused in constant time
//   and nothing throws. Until a token is issued nothing is accepted.
// - Each Host boot issues a new token, so the previous boot's token is refused (rotation).
// - The token never enters argv, the environment, a log record or a frame (NFR-SEC-12): this class
//   is the only holder of the hex, for the duration of one write.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, open, rm } from 'node:fs/promises'
import { join } from 'node:path'

export const UI_TOKEN_FILE = 'ui.token'

const TOKEN_BYTES = 32
const RUN_DIR_MODE = 0o700
const TOKEN_FILE_MODE = 0o600

export interface UiTokenDeps {
  /** Defaults to `crypto.randomBytes`. */
  randomBytes?: (size: number) => Uint8Array
  /** Defaults to `crypto.timingSafeEqual`. */
  timingSafeEqual?: (a: Uint8Array, b: Uint8Array) => boolean
}

export class UiToken {
  private digest: Uint8Array | null = null
  private readonly random: (size: number) => Uint8Array
  private readonly equal: (a: Uint8Array, b: Uint8Array) => boolean

  constructor(deps: UiTokenDeps = {}) {
    this.random = deps.randomBytes ?? randomBytes
    this.equal = deps.timingSafeEqual ?? timingSafeEqual
  }

  /** Mints this boot's token and writes it to `<runDir>/ui.token`; throws when it cannot. */
  async issue(runDir: string): Promise<void> {
    await mkdir(runDir, { recursive: true, mode: RUN_DIR_MODE })
    await chmod(runDir, RUN_DIR_MODE)
    const path = join(runDir, UI_TOKEN_FILE)
    await rm(path, { force: true })
    const hex = Buffer.from(this.random(TOKEN_BYTES)).toString('hex')
    const file = await open(path, 'wx', TOKEN_FILE_MODE)
    try {
      await file.writeFile(hex, 'utf8')
    } finally {
      await file.close()
    }
    this.digest = sha256(hex)
  }

  /** True only for this boot's token. */
  verify(candidate: string): boolean {
    const expected = this.digest
    const actual = sha256(candidate)
    if (expected === null) {
      // Same work as a real comparison, against itself, and still a refusal.
      this.equal(actual, actual)
      return false
    }
    return this.equal(actual, expected)
  }
}

function sha256(text: string): Uint8Array {
  return createHash('sha256').update(text, 'utf8').digest()
}
