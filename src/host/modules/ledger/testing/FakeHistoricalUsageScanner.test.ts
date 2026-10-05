// layer: L3
// L3 (17 §1.3): the double runs the same contract suite as `ProviderHistoryScanner` (16 §2.8).
import { describe } from 'vitest'
import type { MineId } from '../../../kernel/domain/values'
import {
  runHistoricalUsageScannerContract,
  type ContractHistory
} from './historicalUsageScanner.contract'
import { FakeHistoricalUsageScanner } from '../ports/fakes/FakeHistoricalUsageScanner'

const MINE = '00000000-0000-7000-8000-000000000077' as MineId

function fakeSubject(history: ContractHistory) {
  const scanUnitOf = (name: string) => `fake:${name}`
  const shapeOf = (name: string) => history.units.find((u) => u.name === name)?.shape
  const unitKeyOf = (unit: string, record: string) =>
    shapeOf(unit) === 'lifetime' ? `coal:${record}` : record
  const filesOf = (name: string) => {
    const unit = history.units.find((u) => u.name === name)
    return unit === undefined ? 0 : unit.shape === 'lifetime' ? unit.records.length : 1
  }
  const scanner = new FakeHistoricalUsageScanner(
    history.units.map((unit) => ({
      scanUnit: scanUnitOf(unit.name),
      adapterId: 'fake',
      files: filesOf(unit.name),
      ...(unit.unreadable === true ? { unreadable: 'read-failed' } : {}),
      records: unit.records
        .filter((record) => record.inMine)
        .map((record) => ({
          unitKey: unitKeyOf(unit.name, record.id),
          span: unit.shape === 'lifetime' ? ('lifetime' as const) : ('unit' as const),
          mineId: MINE,
          tokens: record.tokens,
          providerTime: record.at
        }))
    }))
  )
  return { scanner, mineId: MINE, scanUnitOf, unitKeyOf, filesOf, dispose: () => undefined }
}

describe('FakeHistoricalUsageScanner', () => {
  runHistoricalUsageScannerContract(fakeSubject)
})
