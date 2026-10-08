import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, onTestFinished } from 'vitest'
import type { FileSystemSubject } from '../../../../kernel/testing/fileSystem.contract'
import { NodeFs } from '../../../../platform/fs/NodeFs'
import {
  engineWorld,
  runConfigWriterEngineContract,
  runExternalConfigWriterContract
} from '../../testing/externalConfigWriter.contract'
import { syntheticLegacyEntry } from '../../testing/syntheticConfigTarget'

// L3 (17 §1.3): the same suites as over FakeFs, on NodeFs over a per-test `mkdtemp` directory
// (17 §5.3), so the temp-and-rename write, the backups and the byte comparisons hold on a disk.
function disk(): FileSystemSubject {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-config-writer-'))
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  return {
    fs: new NodeFs(),
    pathOf: (...segments) => join(root, ...segments),
    seed: async (path, content) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
    }
  }
}

describe('ConfigWriterEngine over NodeFs', () => {
  runConfigWriterEngineContract(disk)

  runExternalConfigWriterContract(async () => {
    const w = await engineWorld(disk())
    return {
      writer: w.writer,
      target: 'opencode-plugin',
      lock: (locked) => w.fs.lock(w.path, locked),
      plantLegacy: () => w.seed(`x=1\n${syntheticLegacyEntry('old-token')}\n`)
    }
  })
})
