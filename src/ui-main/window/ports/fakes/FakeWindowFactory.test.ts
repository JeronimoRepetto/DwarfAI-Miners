import { describe, expect, it } from 'vitest'
import { runWindowFactoryContract } from '../windowFactory.contract'
import { FakeWindowFactory } from './FakeWindowFactory'

runWindowFactoryContract('FakeWindowFactory', () => new FakeWindowFactory())

describe('FakeWindowFactory', () => {
  it('[ADR-019] records each window it builds and what each window was asked', () => {
    const factory = new FakeWindowFactory()
    const panel = factory.panel()
    panel.placeAt({ x: 1, y: 2, width: 3, height: 4 })
    panel.showInactive()
    panel.send('panel:visibility', true)
    factory.veta('display-a')
    factory.veta('display-a')
    expect(factory.built).toEqual([{ kind: 'panel' }, { kind: 'veta', key: 'display-a' }])
    expect(panel.bounds).toEqual({ x: 1, y: 2, width: 3, height: 4 })
    expect(panel.visible).toBe(true)
    expect(panel.pushes).toEqual([{ push: 'panel:visibility', payload: true }])
  })
})
