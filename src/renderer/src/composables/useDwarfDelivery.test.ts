// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { useDwarfDelivery } from './useDwarfDelivery'

function stubApi(overrides: Record<string, unknown> = {}) {
  const api = {
    onDwarfDeliveryReport: vi.fn().mockReturnValue(() => undefined),
    ...overrides
  }
  Object.defineProperty(window, 'api', { configurable: true, value: api })
  return api
}

describe('useDwarfDelivery', () => {
  it('starts with no verdicts at all, which is true when the app starts', () => {
    stubApi()
    expect(useDwarfDelivery().report.value).toEqual({ send: {}, kick: {} })
  })

  it('adopts the verdicts the panel window published', () => {
    const api = stubApi()
    const { report, listen } = useDwarfDelivery()
    listen()
    const push = api.onDwarfDeliveryReport.mock.calls[0]?.[0] as (next: unknown) => void
    push({ send: { 'claude:s1': { phase: 'delivered' } }, kick: {} })
    expect(report.value.send['claude:s1']).toEqual({ phase: 'delivered' })
  })

  it('replaces the whole report rather than merging into it', () => {
    // The panel window's stores expire their own entries on timers, so a
    // marker that is gone from the report is a marker that must go from the
    // mine. Merging would leave every verdict on screen forever.
    const api = stubApi()
    const { report, listen } = useDwarfDelivery()
    listen()
    const push = api.onDwarfDeliveryReport.mock.calls[0]?.[0] as (next: unknown) => void
    push({ send: { 'claude:s1': { phase: 'delivered' } }, kick: {} })
    push({ send: {}, kick: {} })
    expect(report.value).toEqual({ send: {}, kick: {} })
  })

  it('stops listening when told to', () => {
    const stop = vi.fn()
    stubApi({ onDwarfDeliveryReport: vi.fn().mockReturnValue(stop) })
    useDwarfDelivery().listen()()
    expect(stop).toHaveBeenCalledOnce()
  })
})
