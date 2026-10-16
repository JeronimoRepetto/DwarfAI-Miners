// The catalog ceilings as the merge reads them (ADR-009 D2, 15 §2.1, §3). AMENDMENT-18 (owner,
// 2026-10-16): an unordered enum of a ceiling is a non-empty set of allowed values, so one
// provider's drivers keep their own `15` §3 row values (Claude C2 stream-json `cli-flag`, C3 ACP
// `load`) and a value outside the set still fails closed.
import { describe, expect, it } from 'vitest'
import { merge } from '../../domain/mergeCapabilities'
import { CATALOG_RECORDS } from './profiles'

function ceilingOf(id: string) {
  const record = CATALOG_RECORDS.find((candidate) => candidate.profile.id === id)
  if (record === undefined) throw new Error(`no catalog record ${id}`)
  return record.ceiling
}

describe('the catalog ceilings (AMENDMENT-18)', () => {
  it('[ADR-009, C-25, SP-15] the Claude stream-json driver keeps its negotiated resume cli-flag', () => {
    expect(merge(ceilingOf('claude'), { resume: 'cli-flag' }).resume).toBe('cli-flag')
  })

  it('[ADR-009, C-25] the Claude ACP driver keeps its negotiated resume load', () => {
    expect(merge(ceilingOf('claude'), { resume: 'load' }).resume).toBe('load')
  })

  it('[ADR-009, C-25] a resume value outside the Claude set still fails closed to none', () => {
    expect(merge(ceilingOf('claude'), { resume: 'resume' }).resume).toBe('none')
  })
})
