import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe } from 'vitest'
import { InMemoryGateFiles } from './fakes/InMemoryGateFiles'
import { NodeGateFiles } from './gateFiles'
import { runGateFilesContract } from './testing/gateFiles.contract'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('NodeGateFiles (ADR-002 D3)', () => {
  runGateFilesContract('NodeGateFiles', () => {
    const root = mkdtempSync(join(tmpdir(), 'dwarfai-030-gate-'))
    roots.push(root)
    return Promise.resolve(new NodeGateFiles(join(root, 'host', 'run', 'spawn.gate')))
  })
})

describe('InMemoryGateFiles', () => {
  runGateFilesContract('InMemoryGateFiles', () => Promise.resolve(new InMemoryGateFiles()))
})
