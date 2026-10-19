// layer: L7
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The step-4b deletion (ISSUE-239; 21 §2 row 4b "Legacy deleted"; 21 §8 blocker "Delegation token in
 * `OPENCODE_CONFIG_CONTENT`"; ADR-013): today's OpenCode launch leaves the tree with the builder that merged a
 * delegation server entry, token included, into the launched CLI's `OPENCODE_CONFIG_CONTENT`, and with today's
 * `opencodeContinue.ts` relaunch. The Host's OpenCode drivers carry no token in that variable (15 §4.6, C-23). Read as
 * text over the whole of `src`, because the Host never imports legacy code (R16).
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

/** A token value reaching a config entry: the token env name, or a context's own token. */
const TOKEN_VALUE = /\bDELEGATION_TOKEN_ENV\b|DWARFAI_DELEGATION_TOKEN|\bcontext\.token\b/

describe('no delegation token in OPENCODE_CONFIG_CONTENT (21 §8)', () => {
  it('[C-23] no source file builds OPENCODE_CONFIG_CONTENT with a delegation token', () => {
    const builders = filesUnder(SRC)
      .filter(isProductionSource)
      .filter((path) => {
        const text = readFileSync(resolve(SRC, path), 'utf8')
        return /\bOPENCODE_CONFIG_CONTENT\b/.test(text) && TOKEN_VALUE.test(text)
      })
    expect(builders).toEqual([])
  })

  it('[ADR-013] no file named opencodeContinue.ts exists', () => {
    expect(filesUnder(SRC).filter((path) => /(^|\/)opencodeContinue\.ts$/.test(path))).toEqual([])
  })
})
