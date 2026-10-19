// layer: L7
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The step-3d deletion (ISSUE-187; 21 §2 row 3d "Legacy deleted"; §2.1 item 4): today's "Other…" launch leaves the
 * tree. Custom commands are launched only by the Host's `HostedCommandDriver`, which replaced today's
 * `hostedProcesses.ts`, `nodeHostedProcess.ts` and `hostedBoard.ts` (the ISSUE-157 candidate decision); today's
 * `hostedCommand.ts` went with them, its Host copy being `launching/domain/hostedCommand.ts`. Read as text:
 * today's runtime composes no hosted-process registry, and no legacy file answers A-39 `launchHostedProcess`.
 */
const SRC = resolve(import.meta.dirname, '..')

/** The legacy files whose behaviour now lives in `HostedCommandDriver`. */
const DELETED: readonly string[] = [
  'main/sessionLaunch/hostedProcesses.ts',
  'main/sessionLaunch/nodeHostedProcess.ts',
  'main/sessionLaunch/hostedBoard.ts',
  'main/sessionLaunch/hostedCommand.ts'
]

/** Every production `.ts` file under a folder of src (tests may still name the channel to prove its route). */
function productionFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(folder, entry.name)
    if (entry.isDirectory()) return productionFiles(path)
    return /\.ts$/.test(entry.name) && !/\.(test|contract)\.ts$/.test(entry.name) ? [path] : []
  })
}

const relativeOf = (path: string): string =>
  path
    .slice(SRC.length + 1)
    .split('\\')
    .join('/')

describe('step-3d deletion (21 §2 row 3d)', () => {
  it('[ADR-001] runtime.ts composes no hosted-process launch and no legacy A-39 handler remains', () => {
    // AMENDED for ISSUE-243: today's runtime itself left the tree (21 §2 cut 5); while it existed it composed none.
    const runtimePath = resolve(SRC, 'main/runtime/runtime.ts')
    const runtime = existsSync(runtimePath) ? readFileSync(runtimePath, 'utf8') : ''
    expect(runtime).not.toMatch(/sessionLaunch\/(hostedProcesses|nodeHostedProcess|hostedBoard)'/)
    expect(runtime).not.toMatch(/\bHostedProcessRegistry\b|\blaunchHostedProcess\b/)
    for (const file of DELETED) expect(existsSync(resolve(SRC, file)), file).toBe(false)
    // AMENDED for ISSUE-341: src/main itself left the tree (21 §2 cut 5); a folder that is gone holds no handler.
    const handlers = [resolve(SRC, 'main'), resolve(SRC, 'legacy-bridge')]
      .filter((folder) => existsSync(folder))
      .flatMap(productionFiles)
      .filter((path) => /IPC_CHANNELS\.launchHostedProcess\b/.test(readFileSync(path, 'utf8')))
      .map(relativeOf)
    expect(handlers).toEqual([])
  })
})
