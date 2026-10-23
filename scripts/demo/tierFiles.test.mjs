import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_TIER_THRESHOLDS, tierFor } from '../../src/host/modules/mines/domain/tier.ts'
import {
  SOURCE_WALK_RULES,
  sumSourceWeight
} from '../../src/host/modules/mines/adapters/sourceWeight/sourceWalk.ts'
import { fileText, tierFilePlan, writeTierFiles } from './tierFiles.mjs'

const TIERS = ['bronze', 'copper', 'silver', 'gold', 'uranium']

/** The Host's own walk over a planned folder held in memory: what it would weigh, file by file. */
function plannedIo(plan) {
  const files = new Map(plan.map((file) => [`root/${file.relativePath}`, file]))
  const dirs = new Map([['root', new Set()]])
  for (const file of plan) {
    const parts = ['root', ...file.relativePath.split('/')]
    for (let depth = 1; depth < parts.length; depth++) {
      const dir = parts.slice(0, depth).join('/')
      if (!dirs.has(dir)) dirs.set(dir, new Set())
      dirs.get(dir).add(parts[depth])
      if (depth < parts.length - 1) {
        const child = parts.slice(0, depth + 1).join('/')
        if (!dirs.has(child)) dirs.set(child, new Set())
      }
    }
  }
  return {
    list: async (dir) =>
      dirs.has(dir)
        ? {
            ok: true,
            value: [...dirs.get(dir)].map((name) => ({
              name,
              isDirectory: dirs.has(`${dir}/${name}`)
            }))
          }
        : { ok: false, error: 'not-found' },
    size: async (file) => files.get(file)?.bytes ?? null,
    fingerprint: async (file, size, sample) => {
      const { seed, bytes } = files.get(file)
      return `${size}:${createHash('sha1').update(fileText(seed, bytes).slice(0, sample)).digest('hex')}`
    },
    join: (dir, name) => `${dir}/${name}`
  }
}

describe('the fictional source files that give a demo mine its tier', () => {
  it.each(TIERS)(
    'a %s mine weighs into its band through the Host’s own source walk and tier rule',
    async (tier) => {
      const plan = tierFilePlan(tier)
      expect(plan.length, 'even a bronze mine holds some source').toBeGreaterThan(0)
      const weight = await sumSourceWeight('root', SOURCE_WALK_RULES, plannedIo(plan), () => false)
      expect(weight).toHaveProperty('bytes')
      expect(tierFor(weight, DEFAULT_TIER_THRESHOLDS)).toBe(tier)
    }
  )

  it('never plans a file the walk would skip: each is source-ish, under the bundle ceiling and unique', () => {
    const plan = tierFilePlan('uranium')
    expect(plan.length).toBeGreaterThan(0)
    expect(plan.length).toBeLessThan(SOURCE_WALK_RULES.fileCap)
    const heads = new Set()
    for (const file of plan) {
      expect(file.relativePath).toMatch(/^src\/[a-z-]+\/[a-z0-9-]+\.ts$/)
      expect(file.bytes).toBeLessThanOrEqual(SOURCE_WALK_RULES.bundleCeilingBytes)
      heads.add(fileText(file.seed, file.bytes).slice(0, SOURCE_WALK_RULES.duplicateSampleBytes))
    }
    expect(heads.size).toBe(plan.length)
  })

  it('writes text of exactly the planned size, the same text for the same seed', () => {
    expect(Buffer.byteLength(fileText(7, 5_000))).toBe(5_000)
    expect(fileText(7, 5_000)).toBe(fileText(7, 5_000))
    expect(fileText(7, 5_000)).not.toBe(fileText(8, 5_000))
  })

  describe('on disk', () => {
    let dir
    afterEach(() => {
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
      dir = undefined
    })

    it('writes every planned file under the mine folder and nothing outside it', () => {
      dir = mkdtempSync(path.join(tmpdir(), 'dwarfai-demo-tier-'))
      const folder = path.join(dir, 'ore-ledger')
      const plan = tierFilePlan('copper')
      writeTierFiles(folder, plan)
      expect(readdirSync(dir)).toEqual(['ore-ledger'])
      for (const file of plan) {
        const written = path.join(folder, ...file.relativePath.split('/'))
        expect(statSync(written).size).toBe(file.bytes)
        expect(readFileSync(written, 'utf8')).toBe(fileText(file.seed, file.bytes))
      }
    })
  })
})
