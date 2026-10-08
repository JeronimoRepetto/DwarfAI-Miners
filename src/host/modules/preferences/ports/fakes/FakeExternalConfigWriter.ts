// The ExternalConfigWriter double (16 §4.12, §7.5 `FakeExternalConfigWriter`: scripted outcomes).
// Never imported by production code (R14). It keeps which targets hold a DwarfAI-owned entry, an
// idempotent `revert`, a target whose file is locked by its tool (16 §7.4), an old-app entry
// (16 §7.1, AMENDMENT-7) and a scripted install failure, and passes the port-level suite of
// testing/externalConfigWriter.contract.ts that the real engine passes (ISSUE-218). The file-level
// rules (foreign bytes, backups, the ledger) are proven on the engine itself.
import type { Result } from '../../../../kernel/domain/values'
import type {
  ChannelToken,
  ConfigTarget,
  ConsentOrigin,
  ExternalConfigWriter
} from '../externalConfigWriter'

export class FakeExternalConfigWriter implements ExternalConfigWriter {
  private readonly owned = new Set<ConfigTarget>()
  private readonly locked = new Set<ConfigTarget>()
  private readonly legacy = new Set<ConfigTarget>()
  private readonly scripted = new Map<
    ConfigTarget,
    'foreign-entry-conflict' | 'concurrent-modification' | 'io'
  >()
  /** Every `revert` call, in order, whatever its outcome. */
  readonly reverts: ConfigTarget[] = []
  /** Every `install` call, in order, whatever its outcome. */
  readonly installs: Array<{ target: ConfigTarget; origin: ConsentOrigin }> = []

  /** The old app's entry is in the file of `target` (16 §7.1 legacy probe). */
  plantLegacy(target: ConfigTarget): void {
    this.legacy.add(target)
  }

  /** The next `install` of `target` fails with `error` and installs nothing. */
  scriptInstall(
    target: ConfigTarget,
    error: 'foreign-entry-conflict' | 'concurrent-modification' | 'io'
  ): void {
    this.scripted.set(target, error)
  }

  /** The file of `target` is locked by its tool (`true`) or released (`false`). */
  lock(target: ConfigTarget, locked = true): void {
    if (locked) this.locked.add(target)
    else this.locked.delete(target)
  }

  /** Whether DwarfAI's entry of `target` is installed. */
  installed(target: ConfigTarget): boolean {
    return this.owned.has(target)
  }

  install(
    target: ConfigTarget,
    _token: ChannelToken,
    origin: ConsentOrigin
  ): Promise<
    Result<
      { verified: true; backupPath: string | null },
      'foreign-entry-conflict' | 'concurrent-modification' | 'io'
    >
  > {
    this.installs.push({ target, origin })
    const error = this.scripted.get(target)
    if (error !== undefined) {
      this.scripted.delete(target)
      return Promise.resolve({ ok: false, error })
    }
    // An old-app entry is replaced in the same write (AMENDMENT-7).
    this.legacy.delete(target)
    this.owned.add(target)
    return Promise.resolve({ ok: true, value: { verified: true, backupPath: null } })
  }

  verify(target: ConfigTarget): Promise<'verified' | 'absent' | 'mismatch'> {
    return Promise.resolve(this.owned.has(target) ? 'verified' : 'absent')
  }

  revert(target: ConfigTarget): Promise<Result<void, 'locked' | 'io'>> {
    this.reverts.push(target)
    if (this.locked.has(target)) return Promise.resolve({ ok: false, error: 'locked' })
    this.owned.delete(target)
    this.legacy.delete(target)
    return Promise.resolve({ ok: true, value: undefined })
  }

  findLegacy(target: ConfigTarget): Promise<boolean> {
    return Promise.resolve(this.legacy.has(target) && !this.owned.has(target))
  }
}
