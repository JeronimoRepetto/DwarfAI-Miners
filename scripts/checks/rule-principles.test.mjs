import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import eslintConfig from '../../eslint.config.mjs'

/**
 * L7 principle traceability (ADR-004 item 2 and Verification, 05 §5.1, 17 §1.7).
 *
 * Every rule of 05 §5.1 names the ADR-004 principle it enforces, and every principle P1–P13 has
 * a rule. The tags are read from the two configs: a dependency-cruiser rule's `comment`
 * (`ADR-004 P3`, `05 local rule`) and an ESLint boundary message (`R7 (P2): …`,
 * `R19 (ADR-019 D4): …`). The expected tags per rule are the 05 §5.1 "ADR-004" column, written
 * out here independently of the configs.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const depcruiseConfig = createRequire(import.meta.url)(
  path.join(repoRoot, '.dependency-cruiser.cjs')
)

/** 05 §5.1 column "ADR-004": `05` marks a rule local to 05, `ADR-019` R19's owner. */
const EXPECTED = {
  R1: ['P1'],
  R2: ['P3'],
  R3: ['P3'],
  R4: ['P3'],
  R5: ['P10'],
  R6: ['P4'],
  R7: ['P2'],
  R8: ['P13', 'P6'],
  R9: ['P13', 'P5'],
  R10: ['P5'],
  R11: ['05', 'P11'],
  R12: ['P9'],
  R13: ['P6'],
  R14: ['05'],
  R15: ['P3'],
  R16: ['P12'],
  R17: ['P7'],
  R18: ['P8'],
  R19: ['ADR-019']
}
const PRINCIPLES = Array.from({ length: 13 }, (_, index) => `P${index + 1}`)

/** Tags in a dependency-cruiser comment: `ADR-004 P6, P13` and `05 local rule`. */
function commentTags(comment = '') {
  const tags = []
  const principles = /ADR-004 (P\d+(?:, P\d+)*)/.exec(comment)
  if (principles) tags.push(...principles[1].split(', '))
  if (/\b05 local rule\b/.test(comment)) tags.push('05')
  return tags
}

/**
 * `[ruleId, tags]` pairs of an ESLint message: `R1/R3 (P1, P3): …` pairs R1 with P1 and R3 with
 * P3; `R19 (ADR-019 D4): …` tags R19 with ADR-019.
 */
function messageTags(message) {
  const match = /^(R\d+(?:\/R\d+)*) \(([^)]*)\)/.exec(message)
  if (!match) return []
  const ruleIds = match[1].split('/')
  const principles = match[2].match(/P\d+/g) ?? []
  if (principles.length === 0)
    return ruleIds.map((ruleId) => [ruleId, match[2].split(' ').slice(0, 1)])
  if (ruleIds.length === 1) return [[ruleIds[0], principles]]
  return ruleIds.map((ruleId, index) => [ruleId, [principles[index]]])
}

/** Every boundary message of the ESLint config. */
function eslintMessages() {
  const messages = []
  for (const object of eslintConfig) {
    for (const [name, entry] of Object.entries(object.rules ?? {})) {
      if (!Array.isArray(entry)) continue
      if (name === 'no-restricted-imports') {
        messages.push(...entry[1].patterns.map((pattern) => pattern.message))
      }
      if (name === 'no-restricted-syntax') {
        messages.push(...entry.slice(1).map((option) => option.message))
      }
    }
    for (const plugin of Object.values(object.plugins ?? {})) {
      for (const rule of Object.values(plugin.rules ?? {})) {
        if (/^R\d/.test(Object.values(rule.meta?.messages ?? {})[0] ?? '')) {
          messages.push(...Object.values(rule.meta.messages))
        }
      }
    }
  }
  return messages
}

describe('principle traceability (ADR-004)', () => {
  it('[ADR-004] every rule R1–R19 names one principle and every principle P1–P13 has a rule', () => {
    const tagsByRule = {}
    const add = (ruleId, tags) => {
      tagsByRule[ruleId] ??= new Set()
      for (const tag of tags) tagsByRule[ruleId].add(tag)
    }
    for (const rule of depcruiseConfig.forbidden) {
      const ruleId = /^R\d+/.exec(rule.name)?.[0]
      expect(ruleId, `dependency-cruiser rule ${rule.name} names its R id`).toBeDefined()
      const tags = commentTags(rule.comment)
      expect(tags, `dependency-cruiser rule ${rule.name} names its principle`).not.toEqual([])
      add(ruleId, tags)
    }
    for (const message of eslintMessages()) {
      const pairs = messageTags(message)
      expect(pairs, `ESLint message "${message}" names its rule and principle`).not.toEqual([])
      for (const [ruleId, tags] of pairs) add(ruleId, tags)
    }

    const found = Object.fromEntries(
      Object.entries(tagsByRule).map(([ruleId, tags]) => [ruleId, [...tags].sort()])
    )
    expect(found).toEqual(EXPECTED)
    const covered = new Set(Object.values(found).flat())
    for (const principle of PRINCIPLES) {
      expect([...covered], `a rule for ${principle}`).toContain(principle)
    }
  })
})
