// The per-view tokens of the console viewer (ADR-003 item 12, frozen; ADR-031 item 2): the Host
// issues one when the UI asks to open a dwarf's `log` console and checks it on the viewer's `hello`.
//
// - A token is 32 random bytes, written as 64 lower-case hex digits, bound to one `dwarfId` and to
//   its `viewId` (a UUIDv7, the token file's name).
// - Single use: the first `hello` that names its `viewId` consumes it, whatever the token it
//   carries, so a token can never be tried twice.
// - It expires 60 s after issue if unused: a `hello` more than VIEW_TOKEN_TTL_MS after the issue is
//   refused.
// - Only the token's SHA-256 is kept in memory; a check compares the hashes in constant time
//   (`crypto.timingSafeEqual`, as ADR-003 item 5 does for the uiToken). Nothing here logs a token.
// - Nothing survives the Host: a restart forgets every token, and the boot sweeps their files
//   (RunDirViewerTokenFiles.sweep, ADR-015 item 6).
import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto'
import type { DwarfId } from '../../../../kernel/domain/values'
import type { Clock } from '../../../../kernel/ports/clock'
import type { IdGenerator } from '../../../../kernel/ports/idGenerator'

/** ADR-003 item 12: an unused per-view token expires 60 s after issue. */
export const VIEW_TOKEN_TTL_MS = 60_000
/** ADR-003 item 12: a per-view token is 32 bytes. */
export const VIEW_TOKEN_BYTES = 32

export interface IssuedView {
  viewId: string
  /** 64 lower-case hex digits: what the token file holds, and nothing else. */
  token: string
}

interface Pending {
  dwarfId: DwarfId
  hash: Buffer
  issuedAt: number
}

export interface ViewTokenRegistryDeps {
  clock: Clock
  ids: IdGenerator
  /** Defaults to `crypto.randomBytes`; a test passes fixed bytes. */
  randomBytes?: (size: number) => Buffer
}

export class ViewTokenRegistry {
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly deps: ViewTokenRegistryDeps) {}

  /** A new token for `dwarfId`. */
  issue(dwarfId: DwarfId): IssuedView {
    const viewId = this.deps.ids.uuidv7()
    const token = (this.deps.randomBytes ?? nodeRandomBytes)(VIEW_TOKEN_BYTES).toString('hex')
    this.pending.set(viewId, { dwarfId, hash: sha256(token), issuedAt: this.deps.clock.now() })
    return { viewId, token }
  }

  /**
   * The dwarf a viewer's `hello` is bound to, or null to refuse it (AUTH_FAILED). Consumes the
   * `viewId` either way.
   */
  consume(viewId: string, token: string): DwarfId | null {
    const entry = this.pending.get(viewId)
    if (entry === undefined) return null
    this.pending.delete(viewId)
    if (this.deps.clock.now() - entry.issuedAt > VIEW_TOKEN_TTL_MS) return null
    return timingSafeEqual(sha256(token), entry.hash) ? entry.dwarfId : null
  }

  /** Forgets every token that expired and answers their viewIds, so their files can go too. */
  dropExpired(): string[] {
    const now = this.deps.clock.now()
    const expired: string[] = []
    for (const [viewId, entry] of this.pending) {
      if (now - entry.issuedAt > VIEW_TOKEN_TTL_MS) {
        this.pending.delete(viewId)
        expired.push(viewId)
      }
    }
    return expired
  }
}

function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest()
}
