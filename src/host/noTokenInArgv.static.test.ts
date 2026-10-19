// layer: L7
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The step-3b deletion (ISSUE-185; 21 §2 row 3b "Legacy deleted"; ADR-013 items 2, 8): today's Codex launch leaves the
 * tree with the builder that put the delegation token into argv as `-c mcp_servers.jev.env={…token…}`, and with
 * today's `codexResume.ts` relaunch. The Codex drivers' `jev` entry carries only the credential file path (15 §4.4,
 * C-23). Read as text over the whole of `src`, because the Host never imports legacy code (R16).
 */
const SRC = resolve(import.meta.dirname, '..')

/** Every file under a folder of src, as a path relative to src with forward slashes. */
function filesUnder(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(folder, entry.name)
    if (entry.isDirectory()) return filesUnder(path)
    return [
      path
        .slice(SRC.length + 1)
        .split('\\')
        .join('/')
    ]
  })
}

const isProductionSource = (path: string): boolean =>
  /\.ts$/.test(path) && !/\.(test|contract)\.ts$/.test(path) && !/(^|\/)testing\//.test(path)

/** A token value reaching a Codex `mcp_servers` entry: the token env name, or a context's own token. */
const TOKEN_VALUE = /\bDELEGATION_TOKEN_ENV\b|DWARFAI_DELEGATION_TOKEN|\bcontext\.token\b/

describe('no delegation token in argv (ADR-013 item 2)', () => {
  it('[C-23, INV-59] no source builds an mcp_servers env entry holding a token value', () => {
    const builders = filesUnder(SRC)
      .filter(isProductionSource)
      .filter((path) => {
        const text = readFileSync(resolve(SRC, path), 'utf8')
        return (
          /mcp_servers\.\$\{[^}]+\}\.env=|mcp_servers\.jev\.env=/.test(text) &&
          TOKEN_VALUE.test(text)
        )
      })
    expect(builders).toEqual([])
  })

  it('[ADR-013] no file named codexResume.ts exists', () => {
    expect(filesUnder(SRC).filter((path) => /(^|\/)codexResume\.ts$/.test(path))).toEqual([])
  })
})
