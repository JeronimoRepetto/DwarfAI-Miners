// The keystroke relay double (ISSUE-134): records every key the observed-Claude keystroke channel
// presses, in order, with its target. Never imported by production code (R14).
//
// - `refuse` makes each next press answer `refused` (the target terminal could not be identified):
//   nothing is recorded as pressed.
// - `fail` makes each next press throw, as a relay whose process died might.
// - `beforePress` runs just before a key is recorded, so a test can change the world between the
//   channel's last check and the key (the FM-082 race window).
import type {
  KeystrokeRelay,
  KeystrokeTarget
} from '../adapters/observedClaude/ObservedClaudeKeystrokeChannel'
import type { PermissionKeystroke } from '../adapters/observedClaude/keyMap'

export interface PressedKey {
  target: KeystrokeTarget
  key: PermissionKeystroke
}

export class FakeKeystrokeRelay implements KeystrokeRelay {
  readonly pressed: PressedKey[] = []
  refuse = false
  fail = false
  beforePress: (() => void) | null = null

  press(target: KeystrokeTarget, key: PermissionKeystroke): Promise<'pressed' | 'refused'> {
    if (this.fail) return Promise.reject(new Error('relay process exited'))
    if (this.refuse) return Promise.resolve('refused')
    this.beforePress?.()
    this.pressed.push({ target, key })
    return Promise.resolve('pressed')
  }
}
