// The GateFiles contract (17 §1.3, 16 §2.8): one suite run by the real adapter over a per-test
// temporary folder and by the double, so the double cannot drift from what the disk does.
import { expect, it } from 'vitest'
import type { GateFiles } from '../ports'

const MINE = '{"pid":7,"processStartTimeMs":2000,"at":10000}'
const THEIRS = '{"pid":4242,"processStartTimeMs":1000,"at":10001}'

export function runGateFilesContract(name: string, subject: () => Promise<GateFiles>): void {
  it(`[ADR-002] ${name}: a gate is created only where none exists, with its whole content`, async () => {
    const files = await subject()
    expect(await files.read()).toBeNull()
    expect(await files.create(MINE)).toBe('created')
    expect(await files.read()).toBe(MINE)
    expect(await files.create(THEIRS)).toBe('exists')
    expect(await files.read()).toBe(MINE)
  })

  it(`[ADR-002, FM-010] ${name}: removeIf removes the gate only while it holds the given content`, async () => {
    const files = await subject()
    expect(await files.removeIf(MINE)).toBe(false)
    await files.create(THEIRS)
    expect(await files.removeIf(MINE)).toBe(false)
    expect(await files.read()).toBe(THEIRS)
    expect(await files.removeIf(THEIRS)).toBe(true)
    expect(await files.read()).toBeNull()
    expect(await files.create(MINE)).toBe('created')
  })

  it(`[ADR-002, FM-009] ${name}: of many creates at once exactly one wins`, async () => {
    const files = await subject()
    const contents = Array.from({ length: 8 }, (_, i) => `{"pid":${i + 1}}`)
    const results = await Promise.all(contents.map((content) => files.create(content)))
    expect(results.filter((result) => result === 'created')).toHaveLength(1)
    expect(contents).toContain(await files.read())
  })
}
