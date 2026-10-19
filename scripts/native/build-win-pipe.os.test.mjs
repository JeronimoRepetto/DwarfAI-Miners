import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readPeImports } from '../../src/host/platform/endpoint/win-pipe/testing/peImports.ts'
import { NATIVE_MODULES } from './build-win-pipe.mjs'

// L8 Windows (17 §1.8): every binary `pnpm build:native` built for this architecture imports only
// the Windows system DLLs its module links (never a VC++ runtime: the static C runtime) and loads
// node.exe only on first use, so the same file loads in node.exe and in Electron. The Host's pipe
// helper keeps its own check beside its loader (nativeOwnerOnlyPipe.os.test.ts).

const WINDOWS = process.platform === 'win32'
const PREBUILDS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'prebuilds',
  `win32-${process.arch}`
)
/** The C runtime DLLs of a `/MD` build: VC++ redistributable and the universal CRT forwarders. */
const VC_RUNTIME = /^(vcruntime\d+|msvcp\d+|msvcr\d+|ucrtbased?|api-ms-win-crt-.*)\.dll$/i

describe.runIf(WINDOWS)('the built native modules', () => {
  it.each(NATIVE_MODULES.map((module) => [module.binary, module]))(
    '[ADR-002, ADR-003] %s imports no VC++ runtime: only its Windows system DLLs, and node.exe on first use',
    (binary, module) => {
      const file = path.join(PREBUILDS, binary)
      expect(existsSync(file), `${binary} is built (pnpm build:native)`).toBe(true)
      const { machine, imports, delayImports } = readPeImports(file)

      expect(imports.filter((dll) => VC_RUNTIME.test(dll))).toEqual([])
      expect(imports.map((dll) => dll.toLowerCase()).sort()).toEqual(
        module.libs.map((lib) => lib.replace(/\.lib$/, '.dll')).sort()
      )
      expect(delayImports.map((dll) => dll.toLowerCase())).toEqual(['node.exe'])
      expect(machine).toBe(process.arch === 'arm64' ? 0xaa64 : 0x8664)
    }
  )
})
