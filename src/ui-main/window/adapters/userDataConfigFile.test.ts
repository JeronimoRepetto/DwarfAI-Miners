// layer: L2
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CONFIG_FILE_NAME } from '@dwarfai/contracts'
import { readUserDataConfigFile } from './userDataConfigFile'

/**
 * The I/O half of A-29's config layer (14 §2.1; `contracts/config` holds the pure half): the userData config file's
 * text, over a per-test temp folder (17 §5.3). No file is the common case and reads as none.
 */
describe('readUserDataConfigFile', () => {
  const dirs: string[] = []
  const tempDir = (): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dwarfai-config-file-'))
    dirs.push(dir)
    return dir
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('[ADR-019] answers the text of the config file in the userData folder', () => {
    const dir = tempDir()
    const text = '{ "GUILD_AREAS_ENABLED": "true" }\n'
    writeFileSync(path.join(dir, CONFIG_FILE_NAME), text, 'utf8')

    expect(readUserDataConfigFile(dir)).toBe(text)
  })

  it('[ADR-019] answers null when there is no config file', () => {
    expect(readUserDataConfigFile(tempDir())).toBeNull()
  })
})
