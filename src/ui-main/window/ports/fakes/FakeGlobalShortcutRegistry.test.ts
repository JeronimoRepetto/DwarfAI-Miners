import { runGlobalShortcutRegistryContract } from '../globalShortcutRegistry.contract'
import { FakeGlobalShortcutRegistry } from './FakeGlobalShortcutRegistry'

runGlobalShortcutRegistryContract('FakeGlobalShortcutRegistry', () => {
  const registry = new FakeGlobalShortcutRegistry()
  return {
    registry,
    takenByAnotherApp: (accel) => registry.takenByOthers.add(accel),
    press: (accel) => registry.press(accel)
  }
})
