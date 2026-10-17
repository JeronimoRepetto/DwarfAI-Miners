// layer: L7
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Today's Claude ask composition that the cut-2 retirement removed from the bridges (ISSUE-142; 21 §2 cut 2 "Retired
 * at the end"; §1 item 4; §4 row "Claude hook entry"): the hook installer and its channel (whose `restore()` wrote and
 * reinstalled today's Claude hook entry), the observed-Claude permission prompt registry the Claude hook route fed, and
 * the keystroke path that answered it. From cut 2 the Host's evaluated copies in `asking` and the Host ingress are the
 * only path, whatever the route table. The files stay in the legacy tree until cut 5; only their composition is gone.
 * The shared loopback listener stays composed for the OpenCode plugin route until 4a.
 */
const RETIRED_MODULES: readonly string[] = [
  'main/hooks/hookInstaller',
  'main/hooks/hookChannel',
  'main/hooks/permissionPrompts',
  'main/textDelivery/permissionKeys'
]

const BRIDGES = resolve(import.meta.dirname)

/** Every production file under src/legacy-bridge (tests may still import a legacy module to prove a behaviour). */
function productionFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(folder, entry.name)
    if (entry.isDirectory()) return productionFiles(path)
    return /\.ts$/.test(entry.name) && !/\.(test|contract)\.ts$/.test(entry.name) ? [path] : []
  })
}

describe('cut-2 retirement (21 §2 cut 2)', () => {
  it('[ADR-012] no file under src/legacy-bridge imports the legacy hookInstaller, permissionPrompts or permissionKeys modules', () => {
    const files = productionFiles(BRIDGES)
    expect(files.length).toBeGreaterThan(0)
    const importers = files.flatMap((path) => {
      const source = readFileSync(path, 'utf8')
      return RETIRED_MODULES.filter((module) =>
        new RegExp(String.raw`from '(\.\./)+${module}'`).test(source)
      ).map(
        (module) =>
          `${path
            .slice(BRIDGES.length + 1)
            .split('\\')
            .join('/')} → ${module}`
      )
    })
    expect(importers).toEqual([])
  })
})
