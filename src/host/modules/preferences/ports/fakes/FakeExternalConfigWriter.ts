// The ExternalConfigWriter double (16 §4.12 `FakeExternalConfigWriter`). Never imported by
// production code (R14). ISSUE-218 builds it over `FakeHookFs` / `FakeFs` and runs the 16 §7.6
// contract; here it keeps only what the Reset saga needs: which targets hold a DwarfAI-owned
// entry, an idempotent `revert`, and a target whose file is locked by its tool (16 §7.4).
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
  /** Every `revert` call, in order, whatever its outcome. */
  readonly reverts: ConfigTarget[] = []

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
    _origin: ConsentOrigin
  ): Promise<
    Result<
      { verified: true; backupPath: string | null },
      'foreign-entry-conflict' | 'concurrent-modification' | 'io'
    >
  > {
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
    return Promise.resolve({ ok: true, value: undefined })
  }

  findLegacy(_target: ConfigTarget): Promise<boolean> {
    return Promise.resolve(false)
  }
}
