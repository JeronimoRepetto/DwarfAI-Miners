// layer: L1
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * The rows the cut-1 switch retired with no route (21 §2 cut 1 "Retired rows"; ISSUE-123): their preload members stay
 * until the step's deletion issue, so nothing but this test stops a composable from calling one, and the router would
 * refuse the call (METHOD_NOT_FOUND) the person never sees. Scanned as code: comments may still name them.
 */
const RETIRED_MEMBERS = [
  'getDwarfFeed', // A-14
  'setWatchedDwarf', // A-16
  'refreshDwarfTelemetry', // A-17
  'setDwarfTuning', // A-18
  'onShowMine' // A-P5
]

const RENDERER = resolve(import.meta.dirname, '..')

/** A file's code with its comments removed. */
function codeOf(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('the rows the cut-1 switch retired', () => {
  it('[ADR-001] no composable references getDwarfFeed, setWatchedDwarf or refreshDwarfTelemetry', () => {
    const composables = readdirSync(resolve(RENDERER, 'composables'))
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .map((name) => resolve(RENDERER, 'composables', name))
    const scanned = [...composables, resolve(RENDERER, 'App.vue')]
    expect(scanned.length).toBeGreaterThan(1)
    const found = scanned.flatMap((path) => {
      const code = codeOf(path)
      return RETIRED_MEMBERS.filter((member) => new RegExp(`\\b${member}\\b`).test(code)).map(
        (member) => `${path.slice(RENDERER.length + 1)}: ${member}`
      )
    })
    expect(found).toEqual([])
  })
})
