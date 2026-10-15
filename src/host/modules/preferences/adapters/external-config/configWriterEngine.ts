// The one writer of DwarfAI's entries in other tools' configuration files (ADR-016 items 6–7;
// 16 §7; 07 machine 14). Each target plugs in a `ConfigTargetAdapter` that only parses and
// renders bytes; this engine owns the rest:
//
// - `install` (16 §7.2): Tx A records the `config_writes` row before any file I/O (16 §7.3); then,
//   with no transaction open (16 §2.2): read and parse preserving unknown content, the exact
//   ownership probe (a foreign slot is never overwritten), one backup
//   `<file>.dwarfai-bak-<timestamp>` before the first modification per enable, a re-read compared
//   with the first read just before the atomic temp-and-rename write (a change restarts the
//   enable once, a second one gives up with `concurrent-modification`), and a read-back of the
//   written bytes. A sharing violation that outlasts the write's retries falls back to an in-place
//   rewrite behind a fresh pre-write snapshot, restored at boot if the Host died part-way (owner
//   amendment J). Tx B then marks the row verified and the integration `on-verified` with its
//   consent origin, or deletes the Tx A row and leaves the integration as it was.
// - `revert` (16 §7.4): removes exactly DwarfAI's entry (and an old-app entry), foreign bytes
//   identical; a locked file returns `locked` and changes nothing. Then one transaction sets
//   `reverted_at` and the integration `off` with its consent cleared.
// - `settleUnverified` (16 §7.3, 07 S14.11, 13 FM-020): at Host boot, a row a crash left between
//   Tx A and Tx B is re-verified (`on-verified`) or reverted (`off`).
// - `followIngressPort` (07 S14.10, ADR-016 item 3, 16 §7.4): at Host boot, once the hook ingress is
//   bound, an `on-verified` integration's own entry that names another port is written again
//   through the install path, under the consent on record, with an old-app entry left as it is.
// - One call per target at a time: every call queues behind the previous one of its target
//   (16 §7.5), so a revert asked during an install runs after the install's Tx B.
//
// An old-app entry (16 §7.1, AMENDMENT-7) is never adopted: `verify` and the boot settlement see
// only DwarfAI's own entry, `install` replaces the old one in the same write after the backup, and
// `revert` removes it after a backup. Writing the channel token's hash in Tx A and revoking it on
// revert belong to `ChannelTokenStore` (ISSUE-219); since owner amendment M the hash is issued in Tx A here and
// withdrawn in Tx B (failure), and the caller revokes it after a revert.
import { createHash } from 'node:crypto'
import { HostInvariantError } from '../../../../kernel/domain/errors'
import type { Instant, IntegrationId, Result } from '../../../../kernel/domain/values'
import type { Clock } from '../../../../kernel/ports/clock'
import type { DiagnosticsLog } from '../../../../kernel/ports/diagnosticsLog'
import type { FileSystem, FsError } from '../../../../kernel/ports/fileSystem'
import type { IdGenerator } from '../../../../kernel/ports/idGenerator'
import type { Scheduler } from '../../../../kernel/ports/scheduler'
import type { TransactionRunner } from '../../../../kernel/ports/transactionRunner'
import type {
  ChannelToken,
  ConfigTarget,
  ConsentOrigin,
  ExternalConfigWriter
} from '../../ports/externalConfigWriter'
import type { ChannelTokenStore } from '../../ports/channelTokenStore'
import type { IntegrationSettingStore } from '../../ports/integrationSettingStore'
import type { ConfigTargetAdapter, RenderScope } from './configTargetAdapter'
import type { ConfigWriteLedger, ConfigWriteRow } from './configWriteLedger'

type InstallError = 'foreign-entry-conflict' | 'concurrent-modification' | 'io'
type InstallResult = Result<{ verified: true; backupPath: string | null }, InstallError>
type RevertResult = Result<void, 'locked' | 'io'>
type Adapter = ConfigTargetAdapter<unknown>

/** The fresh channel token a rewrite installs (owner amendment M: its hash is issued in Tx A). */
export interface FollowCredential {
  token: ChannelToken
  tokenSha256: string
}

/** What `followIngressPort` did. */
export type FollowOutcome = 'rewritten' | 'current' | 'not-on' | 'failed'

/**
 * Waits before each retry of a write refused by a sharing violation (ADR-016 item 6.4). Package
 * gap: ADR-016 gives no count or delays; two retries within half a second, then the write fails.
 */
const WRITE_RETRY_DELAYS_MS: readonly number[] = [100, 400]

/** 06 §0.1: the integration each target's write turns on. */
const INTEGRATION_OF: Readonly<Record<ConfigTarget, IntegrationId>> = {
  'claude-hooks': 'claude-hooks',
  'opencode-plugin': 'opencode-permissions'
}

/** `07` S14.01, `09` CHECK: the consent entry points each target accepts. */
const ORIGINS_OF: Readonly<Record<ConfigTarget, readonly ConsentOrigin[]>> = {
  'claude-hooks': ['settings', 'first-run'],
  'opencode-plugin': ['settings', 'add-panel', 'first-run']
}

/** The `config.write` cause of a rewrite onto a new ingress port (07 S14.10; package gap: 19 §9.5 lists none). */
const FOLLOWED_PORT = 'ingress-port-changed'

/** The stored form of a channel token: the SHA-256 of its hex text, as lower-case hex (ADR-016 item 1). */
const sha256Hex = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex')

const isLock = (error: FsError): boolean => error === 'busy' || error === 'access-denied'

function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b
  if (a.byteLength !== b.byteLength) return false
  for (let at = 0; at < a.byteLength; at += 1) if (a[at] !== b[at]) return false
  return true
}

/**
 * Owner amendment J: the pre-write snapshot of an in-place write, beside the backups and named by
 * its `config_writes` row, so the boot finds it from the ledger with no schema change.
 */
const snapshotPathOf = (path: string, rowId: string): string => `${path}.dwarfai-prewrite-${rowId}`

/** `20261008T120000123Z`: a UTC instant sortable by name and valid in every OS's file names. */
function backupStamp(at: Instant): string {
  return new Date(at).toISOString().replace(/[-:.]/g, '')
}

export interface ConfigWriterEngineDeps {
  fs: FileSystem
  transactions: TransactionRunner
  ledger: ConfigWriteLedger
  settings: IntegrationSettingStore
  /** `channel_tokens` (owner amendment M): a write's token hash is issued in its Tx A and withdrawn in Tx B (failure). */
  tokens: ChannelTokenStore
  clock: Clock
  ids: IdGenerator
  /** Schedules the waits between write retries (16 §2.6: every wait is a scheduler task). */
  scheduler: Scheduler
  log: DiagnosticsLog
  /** One adapter per target this Host writes (ISSUE-220 `claude-hooks`, ISSUE-227 `opencode-plugin`). */
  targets: readonly Adapter[]
}

export class ConfigWriterEngine implements ExternalConfigWriter {
  private readonly queues = new Map<ConfigTarget, Promise<unknown>>()

  constructor(private readonly deps: ConfigWriterEngineDeps) {}

  async install(
    target: ConfigTarget,
    token: ChannelToken,
    origin: ConsentOrigin,
    tokenSha256: string
  ): Promise<InstallResult> {
    const adapter = this.adapterOf(target)
    if (!ORIGINS_OF[target].includes(origin)) {
      throw new HostInvariantError(`consent origin ${origin} cannot enable ${target} (07 S14.01)`)
    }
    return this.queued(target, async () => {
      // 16 §7.5: enabling an `on-verified` target is a no-op returning the current state. Only `on-verified`: an
      // `on-unverified` integration (07 S14.08) is written again when turned on (S14.09), even when its entry still
      // verifies, so the file holds the token the caller has just issued (ISSUE-221, review F2).
      const previous = this.deps.ledger.active(adapter.target, adapter.path)
      if (
        this.deps.settings.get(INTEGRATION_OF[adapter.target]).state === 'on-verified' &&
        previous !== null &&
        previous.verifiedAt !== null &&
        (await this.check(adapter)) === 'verified'
      ) {
        this.logWrite(adapter.target, origin, 'skipped')
        return { ok: true, value: { verified: true, backupPath: previous.backupPath } }
      }
      return this.enable(adapter, token, origin, tokenSha256, 'with-old-app')
    })
  }

  async verify(target: ConfigTarget): Promise<'verified' | 'absent' | 'mismatch'> {
    return this.check(this.adapterOf(target))
  }

  async revert(target: ConfigTarget): Promise<RevertResult> {
    const adapter = this.adapterOf(target)
    return this.queued(target, () => this.disable(adapter))
  }

  async findLegacy(target: ConfigTarget): Promise<boolean> {
    const adapter = this.adapterOf(target)
    if (this.deps.ledger.active(target, adapter.path) !== null) return false
    const read = await this.deps.fs.readFile(adapter.path)
    if (!read.ok) return false
    const doc = adapter.read(read.value)
    return doc.ok && adapter.probeLegacy(doc.value)
  }

  /**
   * Host boot (16 §7.3, 07 S14.11): every live write a crash left unverified is verified again;
   * `verified` turns the integration `on-verified` with the row's consent, anything else reverts it
   * to `off`. A revert that fails (a locked file) leaves the row for the next boot. Owner amendment
   * J: when the crash hit an in-place write, its pre-write snapshot is still on disk; a file that is
   * neither DwarfAI's verified write nor the snapshot (partial, truncated, malformed) gets the
   * snapshot back byte for byte first. A restore that fails keeps the row and the snapshot for the
   * next boot.
   */
  async settleUnverified(): Promise<void> {
    for (const row of this.deps.ledger.unverified()) {
      const adapter = this.deps.targets.find(
        (candidate) => candidate.target === row.kind && candidate.path === row.targetPath
      )
      if (adapter === undefined) continue
      await this.queued(row.kind, async () => {
        const status = await this.check(adapter)
        if (!(await this.settleSnapshot(adapter, row, status === 'verified'))) return
        if (status === 'verified') {
          this.deps.transactions.inTransaction(() => this.markOn(row, row.backupPath))
        } else {
          await this.disable(adapter)
        }
      })
    }
  }

  /**
   * 07 S14.10 (ADR-016 item 3; 16 §7.4): the hook ingress could not keep its persisted port, so
   * DwarfAI's own entry may name a port nothing listens on. Only an `on-verified` integration whose
   * live write is verified and whose own entry is still in the file is followed (an `on-unverified`
   * one is written again only when the person turns it on, S14.09; an `off` one has no consent).
   * An entry that already names the port is left alone. Otherwise the entry is written again
   * through the enable's own path (Tx A with the fresh token's hash, probe, one backup, atomic
   * write, read-back, Tx B) under the consent already on record, replacing DwarfAI's own entry
   * only: an old-app entry is never written here (16 §7.1). A failed rewrite is Tx B (failure):
   * nothing changes, the previous token stays active, and the integration stays as it was.
   */
  async followIngressPort(
    target: ConfigTarget,
    credential: () => FollowCredential
  ): Promise<FollowOutcome> {
    const adapter = this.adapterOf(target)
    return this.queued(target, async () => {
      const { ledger, settings } = this.deps
      const active = ledger.active(adapter.target, adapter.path)
      if (
        settings.get(INTEGRATION_OF[adapter.target]).state !== 'on-verified' ||
        active === null ||
        active.verifiedAt === null
      ) {
        return 'not-on'
      }
      const read = await this.readTarget(adapter)
      if (!read.ok || read.value === null) return 'not-on'
      const doc = adapter.read(read.value)
      if (!doc.ok || adapter.probeOwned(doc.value) !== 'owned') return 'not-on'
      if (adapter.isCurrent?.(doc.value) ?? true) return 'current'
      const { token, tokenSha256 } = credential()
      const written = await this.enable(
        adapter,
        token,
        active.consentOrigin,
        tokenSha256,
        'owned-only'
      )
      return written.ok ? 'rewritten' : 'failed'
    })
  }

  // --- install ------------------------------------------------------------------------------

  private async enable(
    adapter: Adapter,
    token: ChannelToken,
    origin: ConsentOrigin,
    tokenSha256: string,
    scope: RenderScope
  ): Promise<InstallResult> {
    const { ledger, tokens, transactions, clock, ids } = this.deps
    const previous = ledger.active(adapter.target, adapter.path)
    const row: ConfigWriteRow = {
      id: previous?.id ?? ids.uuidv7(),
      kind: adapter.target,
      targetPath: adapter.path,
      ownedMarker: adapter.ownedMarker,
      backupPath: previous?.backupPath ?? null,
      consentOrigin: origin,
      writtenAt: clock.now(),
      verifiedAt: null,
      revertedAt: null
    }
    // Tx A: the attempt is on record before the file is touched (16 §7.3), and so is the new token's hash, which
    // revokes the channel's previous one (owner amendment M). Both commit together: no crash can leave one without
    // the other, and the previous hash is read here, in the same transaction, for Tx B (failure) to restore.
    const prior = transactions.inTransaction(() => {
      const active = tokens.active(adapter.target)
      tokens.issue(adapter.target, tokenSha256, clock.now())
      ledger.record(row)
      return active === null ? null : active.hash
    })

    const outcome = await this.writeOwned(adapter, token, row.id, scope)
    if (outcome === 'leave-for-boot') {
      // An in-place write left the file in an unknown state: like a crash between Tx A and Tx B,
      // the row and the snapshot stay for the boot settlement (owner amendment J).
      this.logWrite(adapter.target, origin, 'failed', 'io')
      return { ok: false, error: 'io' }
    }
    const written = outcome

    if (written.ok) {
      // Tx B (success).
      transactions.inTransaction(() => this.markOn(row, written.value.backupPath))
      // 07 S14.10 "logged": a rewrite onto a new ingress port says so; an enable logs as it always did.
      this.logWrite(
        adapter.target,
        origin,
        'ok',
        scope === 'owned-only' ? FOLLOWED_PORT : undefined
      )
    } else {
      // Tx B (failure): nothing of this enable stays on record; the integration is unchanged, and the previous
      // token is the active one again (owner amendment M).
      transactions.inTransaction(() => {
        tokens.withdraw(adapter.target, tokenSha256, prior, clock.now())
        if (previous === null) ledger.remove(row.id)
        else ledger.record(previous)
      })
      this.logWrite(adapter.target, origin, 'failed', written.error)
    }
    return written
  }

  /** Steps 1–6 of 16 §7.2; no transaction is open while it runs. */
  private async writeOwned(
    adapter: Adapter,
    token: ChannelToken,
    rowId: string,
    scope: RenderScope
  ): Promise<InstallResult | 'leave-for-boot'> {
    let backupPath: string | null = null
    let backedUp = false
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      // 1. Read and parse, preserving unknown content.
      const before = await this.readTarget(adapter)
      if (!before.ok) return { ok: false, error: 'io' }
      const doc = adapter.read(before.value)
      if (!doc.ok) return { ok: false, error: 'io' } // 13 FM-127: nothing is written
      // 2. The exact ownership probe.
      if (adapter.probeOwned(doc.value) === 'foreign') {
        return { ok: false, error: 'foreign-entry-conflict' }
      }
      const next = adapter.render(doc.value, token, scope)
      // 3. One backup before the first modification of the file in this enable.
      if (!backedUp && before.value !== null) {
        const backup = await this.backUp(adapter.path, before.value)
        if (!backup.ok) return { ok: false, error: 'io' }
        backupPath = backup.value
      }
      backedUp = true
      // 5. Re-read just before the write: a change by the tool restarts the enable once.
      const now = await this.readTarget(adapter)
      if (!now.ok) return { ok: false, error: 'io' }
      if (!sameBytes(now.value, before.value)) continue
      // 4. The atomic write, retried on a sharing violation; in place only as the last resort.
      let inPlace = false
      const write = await this.writeWithRetries(adapter.path, next)
      if (!write.ok) {
        if (!isLock(write.error) || before.value === null) return { ok: false, error: 'io' }
        const fallback = await this.writeInPlaceBehindSnapshot(adapter, rowId, before.value, next)
        if (fallback === 'changed') continue
        if (fallback === 'failed') return { ok: false, error: 'io' }
        if (fallback === 'leave-for-boot') return fallback
        inPlace = true
      }
      // 6. The read-back.
      const back = await this.readTarget(adapter)
      if (!back.ok || !sameBytes(back.value, next)) {
        if (inPlace) return 'leave-for-boot'
        await this.removeEntries(adapter, false)
        return { ok: false, error: 'io' }
      }
      if (inPlace) await this.deps.fs.deleteFile(snapshotPathOf(adapter.path, rowId))
      return { ok: true, value: { verified: true, backupPath } }
    }
    return { ok: false, error: 'concurrent-modification' }
  }

  /**
   * Owner amendment J: the in-place rewrite of ADR-016 item 6.4, behind a snapshot of the file's
   * bytes as they are at this moment, persisted before the write (the per-enable backup may be
   * older). `changed`: the tool changed the file, the enable restarts. `failed`: nothing of the
   * write stayed. `leave-for-boot`: a failed write that could not be undone.
   */
  private async writeInPlaceBehindSnapshot(
    adapter: Adapter,
    rowId: string,
    expected: Uint8Array,
    next: Uint8Array
  ): Promise<'written' | 'changed' | 'failed' | 'leave-for-boot'> {
    const { fs } = this.deps
    const fresh = await this.readTarget(adapter)
    if (!fresh.ok || fresh.value === null) return 'failed'
    const snapshot = fresh.value
    if (!sameBytes(snapshot, expected)) return 'changed'
    const snapshotPath = snapshotPathOf(adapter.path, rowId)
    const saved = await fs.writeFileAtomic(snapshotPath, snapshot)
    if (!saved.ok) return 'failed'
    const written = await this.withRetries(() => fs.writeFileInPlace(adapter.path, next))
    if (written.ok) return 'written'
    // The failed write may have left part of the file: the snapshot goes back first.
    const restored = await this.withRetries(() => fs.writeFileInPlace(adapter.path, snapshot))
    if (!restored.ok) return 'leave-for-boot'
    await fs.deleteFile(snapshotPath)
    return 'failed'
  }

  /**
   * The boot half of owner amendment J. Returns whether the row may be settled now: `false` when a
   * needed restore failed (the row and the snapshot wait for the next boot).
   */
  private async settleSnapshot(
    adapter: Adapter,
    row: ConfigWriteRow,
    verified: boolean
  ): Promise<boolean> {
    const { fs } = this.deps
    const snapshotPath = snapshotPathOf(row.targetPath, row.id)
    const snapshot = await fs.readFile(snapshotPath)
    if (!snapshot.ok) return true
    const current = await this.readTarget(adapter)
    const intact = current.ok && sameBytes(current.value, snapshot.value)
    if (!verified && !intact) {
      const restored = await this.restoreSnapshot(adapter.path, snapshot.value)
      // ADR-026: ids, outcome and cause only, never a byte of the file.
      this.logWrite(
        adapter.target,
        row.consentOrigin,
        restored.ok ? 'degraded' : 'failed',
        restored.ok ? 'partial-write-restored' : 'io'
      )
      if (!restored.ok) return false
    }
    await fs.deleteFile(snapshotPath)
    return true
  }

  /** The snapshot back, byte for byte: atomically when possible, else in place. */
  private async restoreSnapshot(path: string, bytes: Uint8Array): Promise<Result<void, FsError>> {
    const atomic = await this.writeWithRetries(path, bytes)
    if (atomic.ok || !isLock(atomic.error)) return atomic
    return this.withRetries(() => this.deps.fs.writeFileInPlace(path, bytes))
  }

  /** Tx B (success), and the boot settlement of a verified row. */
  private markOn(row: ConfigWriteRow, backupPath: string | null): void {
    const at = this.deps.clock.now()
    this.deps.ledger.markVerified(row.id, at, backupPath)
    this.deps.settings.save({
      id: INTEGRATION_OF[row.kind],
      state: 'on-verified',
      consentOrigin: row.consentOrigin,
      changedAt: at
    })
  }

  // --- revert -------------------------------------------------------------------------------

  private async disable(adapter: Adapter): Promise<RevertResult> {
    const { ledger, settings, transactions, clock } = this.deps
    const active = ledger.active(adapter.target, adapter.path)
    // An old-app entry has no `config_writes` row: it is backed up first (16 §7.4 first-run).
    const removed = await this.removeEntries(adapter, active === null)
    if (!removed.ok) {
      this.logRevert(adapter.target, 'failed', removed.error)
      return removed
    }
    const integration = INTEGRATION_OF[adapter.target]
    transactions.inTransaction(() => {
      const at = clock.now()
      if (active !== null) ledger.markReverted(active.id, at)
      if (settings.get(integration).state !== 'off') {
        settings.save({ id: integration, state: 'off', changedAt: at })
      }
    })
    this.logRevert(adapter.target, 'ok')
    return { ok: true, value: undefined }
  }

  /** Removes DwarfAI's and the old app's entries, foreign bytes identical; absent ones succeed. */
  private async removeEntries(adapter: Adapter, backUpFirst: boolean): Promise<RevertResult> {
    const read = await this.deps.fs.readFile(adapter.path)
    if (!read.ok) {
      if (read.error === 'not-found') return { ok: true, value: undefined }
      return { ok: false, error: isLock(read.error) ? 'locked' : 'io' }
    }
    const doc = adapter.read(read.value)
    if (!doc.ok) return { ok: false, error: 'io' }
    const owned = adapter.probeOwned(doc.value) === 'owned'
    if (!owned && !adapter.probeLegacy(doc.value)) return { ok: true, value: undefined }
    if (backUpFirst) {
      const backup = await this.backUp(adapter.path, read.value)
      if (!backup.ok) return { ok: false, error: 'io' }
    }
    const next = adapter.removeOwned(doc.value)
    const done =
      next === null
        ? await this.deleteWithRetries(adapter.path)
        : await this.writeWithRetries(adapter.path, next)
    if (done.ok) return { ok: true, value: undefined }
    return { ok: false, error: isLock(done.error) ? 'locked' : 'io' }
  }

  // --- shared -------------------------------------------------------------------------------

  /**
   * `verify` (16 §4.12): only DwarfAI's own entry counts; an unreadable file is a mismatch. An entry
   * is verified only when it carries the channel's ACTIVE token (07 S14.11; issue #1307): Tx A makes
   * a new token's hash the active one before the file is written, so an entry a crash or a locked
   * file left with the previous token would be answered `401` by the ingress. Compared by hash: the
   * plaintext is never logged or stored.
   */
  private async check(adapter: Adapter): Promise<'verified' | 'absent' | 'mismatch'> {
    const read = await this.readTarget(adapter)
    if (!read.ok) return 'mismatch'
    if (read.value === null) return 'absent'
    const doc = adapter.read(read.value)
    if (!doc.ok) return 'mismatch'
    const probe = adapter.probeOwned(doc.value)
    if (probe === 'absent') return 'absent'
    if (probe === 'foreign') return 'mismatch'
    return this.carriesActiveToken(adapter, doc.value) ? 'verified' : 'mismatch'
  }

  /** Every token DwarfAI's own entry carries hashes to the channel's active hash. */
  private carriesActiveToken(adapter: Adapter, doc: unknown): boolean {
    if (adapter.ownedTokens === undefined) return true
    const active = this.deps.tokens.active(adapter.target)
    const carried = adapter.ownedTokens(doc)
    return (
      active !== null &&
      carried.length > 0 &&
      carried.every((token) => sha256Hex(token) === active.hash)
    )
  }

  /** The target's bytes, `null` when the file does not exist. */
  private async readTarget(adapter: Adapter): Promise<Result<Uint8Array | null, FsError>> {
    const read = await this.deps.fs.readFile(adapter.path)
    if (read.ok) return read
    return read.error === 'not-found' ? { ok: true, value: null } : read
  }

  /** `<file>.dwarfai-bak-<timestamp>`, never over an earlier backup (ADR-016 item 6.3). */
  private async backUp(path: string, bytes: Uint8Array): Promise<Result<string, FsError>> {
    const base = `${path}.dwarfai-bak-${backupStamp(this.deps.clock.now())}`
    let candidate = base
    for (let n = 2; await this.deps.fs.exists(candidate); n += 1) candidate = `${base}-${n}`
    const written = await this.deps.fs.writeFileAtomic(candidate, bytes)
    return written.ok ? { ok: true, value: candidate } : written
  }

  /** ADR-016 item 6.4: temp-and-rename, retried on a sharing violation. */
  private writeWithRetries(path: string, bytes: Uint8Array): Promise<Result<void, FsError>> {
    return this.withRetries(() => this.deps.fs.writeFileAtomic(path, bytes))
  }

  private async deleteWithRetries(path: string): Promise<Result<void, FsError>> {
    const deleted = await this.withRetries(() => this.deps.fs.deleteFile(path))
    return !deleted.ok && deleted.error === 'not-found' ? { ok: true, value: undefined } : deleted
  }

  private async withRetries(
    operation: () => Promise<Result<void, FsError>>
  ): Promise<Result<void, FsError>> {
    let result = await operation()
    for (const delay of WRITE_RETRY_DELAYS_MS) {
      if (result.ok || !isLock(result.error)) return result
      await new Promise<void>((resolve) => this.deps.scheduler.after(delay, resolve))
      result = await operation()
    }
    return result
  }

  private queued<T>(target: ConfigTarget, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(target) ?? Promise.resolve()
    const run = previous.then(work, work)
    this.queues.set(
      target,
      run.catch(() => undefined)
    )
    return run
  }

  private adapterOf(target: ConfigTarget): Adapter {
    const adapter = this.deps.targets.find((candidate) => candidate.target === target)
    if (adapter === undefined)
      throw new HostInvariantError(`no config target adapter for ${target}`)
    return adapter
  }

  /** 19 §9.5 `config.write`: target, outcome, cause; `msg` is the consent origin. */
  private logWrite(
    target: ConfigTarget,
    origin: ConsentOrigin,
    outcome: 'ok' | 'failed' | 'skipped' | 'degraded',
    cause?: InstallError | 'partial-write-restored' | typeof FOLLOWED_PORT
  ): void {
    this.deps.log.record({
      level: outcome === 'failed' ? 'warn' : 'info',
      event: 'config.write',
      subsystem: target,
      outcome,
      msg: origin,
      ...(cause === undefined ? {} : { causeClass: cause })
    })
  }

  /** 19 §9.5 `config.revert`: target, outcome, cause. */
  private logRevert(target: ConfigTarget, outcome: 'ok' | 'failed', cause?: 'locked' | 'io'): void {
    this.deps.log.record({
      level: outcome === 'failed' ? 'warn' : 'info',
      event: 'config.revert',
      subsystem: target,
      outcome,
      ...(cause === undefined ? {} : { causeClass: cause })
    })
  }
}
