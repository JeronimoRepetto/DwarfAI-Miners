import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

/**
 * L7 static check (17 §1.7; ADR-019 item 1 and Verification; 18 C-01): every `BrowserWindow` comes from the one
 * factory, so `new BrowserWindow(` anywhere in the new trees but `src/ui-main/window/adapters/secureWindowOptions.ts`
 * fails the lint (tagged R19, the rule 05 §5.1 gives to ADR-019; eslint.config.mjs deviation 5). Each snippet is
 * linted with the repository's own config as if it sat at a scratch path, and nothing is written to the tree; the
 * canary job proves the same rule with lint-canaries/R19-browser-window.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const eslint = new ESLint({ cwd: repoRoot })

const MESSAGE = 'R19 (ADR-019 D1): build every BrowserWindow through secureWindowOptions.'

async function factoryMessages(code, file) {
  const results = await eslint.lintText(code, { filePath: path.join(repoRoot, ...file.split('/')) })
  return results
    .flatMap((result) => result.messages)
    .filter((message) => message.ruleId === 'no-restricted-syntax' && message.message === MESSAGE)
    .map((message) => message.line)
}

const DIRECT = "import { BrowserWindow } from 'electron'\nexport const w = new BrowserWindow({})\n"
const NAMESPACED =
  "import * as electron from 'electron'\nexport const w = new electron.BrowserWindow({})\n"

describe('the window factory lint rule (ADR-019 item 1)', () => {
  it('[ADR-019] no new BrowserWindow outside secureWindowOptions', async () => {
    const scratch = [
      'src/ui-main/window/adapters/scratchWindow.ts',
      'src/ui-main/window/application/scratchWindow.ts',
      'src/ui-main/index.ts',
      'src/ui-main/hostLauncher/scratchWindow.ts',
      'src/preload/scratchWindow.ts',
      'src/host/kernel/scratchWindow.ts',
      'src/contracts/text/scratchWindow.ts',
      'src/renderer/src/lib/scratchWindow.ts',
      'src/renderer/src/composables/scratchWindow.ts'
    ]
    for (const file of scratch) {
      expect(await factoryMessages(DIRECT, file), `${file} new BrowserWindow`).toEqual([2])
      expect(await factoryMessages(NAMESPACED, file), `${file} new electron.BrowserWindow`).toEqual(
        [2]
      )
    }
    expect(
      await factoryMessages(DIRECT, 'src/ui-main/window/adapters/secureWindowOptions.ts'),
      'the factory itself'
    ).toEqual([])
  })
})
