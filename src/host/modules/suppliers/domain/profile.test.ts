import { describe, expect, it } from 'vitest'
import { FAIL_CLOSED_CAPABILITIES } from './capabilities'
import { recordsForBuild, type CatalogRecord } from './profile'

function record(id: string, developmentOnly?: boolean): CatalogRecord {
  return {
    profile: {
      id,
      label: id,
      binaries: [],
      models: [],
      efforts: [],
      permissionModes: [],
      drivers: [],
      publicLaunch: 'enabled'
    },
    ceiling: FAIL_CLOSED_CAPABILITIES,
    ...(developmentOnly === undefined ? {} : { developmentOnly })
  }
}

describe('recordsForBuild', () => {
  const records = [record('first'), record('dev-world', true), record('second', false)]

  it('[ADR-009] a public build drops every development-only record and keeps the others in order', () => {
    expect(recordsForBuild(records, { publicBuild: true }).map((r) => r.profile.id)).toEqual([
      'first',
      'second'
    ])
  })

  it('[ADR-009] a development build keeps every record in order', () => {
    expect(recordsForBuild(records, { publicBuild: false }).map((r) => r.profile.id)).toEqual([
      'first',
      'dev-world',
      'second'
    ])
  })
})
