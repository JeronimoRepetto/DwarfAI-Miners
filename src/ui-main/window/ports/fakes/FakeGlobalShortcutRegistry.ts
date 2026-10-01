import type { GlobalShortcutRegistry } from '../globalShortcutRegistry'

/**
 * Hand-written double of `GlobalShortcutRegistry` (16 §4.14, 16 §2.8): the OS's table of global
 * shortcuts as this process sees it. A combination another application owns (`takenByOthers`)
 * or this process already holds is refused with `false`, as the port says. `press()` plays the
 * person pressing a combination: the registrant that holds it fires, nothing else happens.
 */
export class FakeGlobalShortcutRegistry implements GlobalShortcutRegistry {
  readonly takenByOthers = new Set<string>()
  readonly registerCalls: string[] = []
  readonly unregisterCalls: string[] = []
  private readonly held = new Map<string, () => void>()

  constructor(takenByOthers: Iterable<string> = []) {
    for (const accel of takenByOthers) this.takenByOthers.add(accel)
  }

  register(accel: string, onFire: () => void): boolean {
    this.registerCalls.push(accel)
    if (this.takenByOthers.has(accel) || this.held.has(accel)) return false
    this.held.set(accel, onFire)
    return true
  }

  unregister(accel: string): void {
    this.unregisterCalls.push(accel)
    this.held.delete(accel)
  }

  /** The combinations this process holds, in registration order. */
  get heldAccelerators(): string[] {
    return [...this.held.keys()]
  }

  /** The person presses `accel`; answers whether a registrant of this process fired. */
  press(accel: string): boolean {
    const onFire = this.held.get(accel)
    if (onFire === undefined) return false
    onFire()
    return true
  }
}
