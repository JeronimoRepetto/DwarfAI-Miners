import type { AutostartPort } from '../autostartPort'

/** The login entry as the OS holds it: none, or one that starts the app, or one the person disabled in the OS list. */
export type FakeLoginEntry = 'absent' | 'enabled' | 'disabled-in-os'

/**
 * Hand-written double of `AutostartPort` (16 §4.14, 16 §2.8), scriptable for machine 40 (07) and FM-147 (13): `refuse`
 * makes `set` throw (`'next'` once, `'always'` from now on) and leaves the entry as it was; `disagreeOnReadBack` makes
 * the first `get()` after the next `set` answer the opposite of the entry; `disableInOs()` plays the person disabling the entry in the OS's own
 * startup list, which `get()` reads as `false` and `set(true)` never overrides. `calls` records every member call.
 */
export class FakeAutostartPort implements AutostartPort {
  entry: FakeLoginEntry = 'absent'
  refuse: 'never' | 'next' | 'always' = 'never'
  disagreeOnReadBack = false
  private readBackDisagrees = false
  /** How many times the entry was written (created or rewritten). */
  writes = 0
  readonly calls: string[] = []

  get(): boolean {
    this.calls.push('get')
    const starts = this.entry === 'enabled'
    if (this.readBackDisagrees) {
      this.readBackDisagrees = false
      return !starts
    }
    return starts
  }

  set(on: boolean): void {
    this.calls.push(`set ${on}`)
    if (this.disagreeOnReadBack) {
      this.disagreeOnReadBack = false
      this.readBackDisagrees = true
    }
    if (this.refuse !== 'never') {
      if (this.refuse === 'next') this.refuse = 'never'
      throw Object.assign(new Error('FakeAutostartPort: the OS refused the login entry'), {
        code: 'EACCES'
      })
    }
    if (!on) {
      this.entry = 'absent'
      return
    }
    // The person's choice in the OS list wins: nothing is written over a disabled entry (ADR-027 item 7).
    if (this.entry === 'disabled-in-os') return
    this.entry = 'enabled'
    this.writes += 1
  }

  disableInOs(): void {
    if (this.entry === 'enabled') this.entry = 'disabled-in-os'
  }
}
