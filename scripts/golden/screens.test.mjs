import { describe, expect, it } from 'vitest'
import {
  TASKBAR,
  clusterSummary,
  coveredError,
  cropImage,
  isScreenState,
  pickTarget,
  restPoint,
  screenPlan,
  workArea
} from './screens.mjs'

/*
 * The pure rules of the full-screen goldens (#635): how a recipe's steps become steps on the app,
 * how a click finds the one element it names, where the pointer rests, and how a window box is
 * cut out of a full-screen reference. No browser and no design repository: every row, selector
 * and label here is a stand-in written for the test, in the manifest's shape.
 */

const SAMPLES = [
  { id: 'valley', label: 'Everything' },
  { id: 'empty', label: 'Nothing yet' }
]

const row = (over = {}) => ({
  viewport: { width: 1000, height: 700 },
  steps: [],
  hidden: ['.x-fab, .x-plate', '.x-controls'],
  windows: [{ name: 'Shell', selector: '.x-shell', x: 600, y: 10, width: 400, height: 600 }],
  ...over
})

describe('isScreenState', () => {
  it('tells a full-screen reference from a kit state by its key', () => {
    expect(isScreenState('screens-full/panel#map')).toBe(true)
    expect(isScreenState('organisms/nav#default')).toBe(false)
  })
})

describe('workArea', () => {
  it('is the screen less the taskbar the references draw under it', () => {
    expect(workArea({ width: 1600, height: 1000 })).toEqual({ width: 1600, height: 1000 - TASKBAR })
  })
})

describe('screenPlan', () => {
  it('keeps the recipe steps, in order, as steps on the app', () => {
    const steps = [{ click: '.x-nav .x-slot', say: 'a slot' }, { key: 'Escape' }]
    expect(screenPlan('s#a', row({ steps }), SAMPLES)).toEqual({
      sample: null,
      steps: [{ click: '.x-nav .x-slot' }, { key: 'Escape' }],
      windows: row().windows
    })
  })

  it('keeps the text a click is narrowed to', () => {
    const steps = [{ click: '.x-btn', text: 'Go', say: 'Go' }]
    expect(screenPlan('s#a', row({ steps }), SAMPLES).steps).toEqual([
      { click: '.x-btn', text: 'Go' }
    ])
  })

  it('turns a click on a hidden prototype control into the sample set it names', () => {
    const steps = [
      { click: '.x-controls .x-toggle[aria-label="Nothing yet"]', say: 'the switch' },
      { click: '.x-nav .x-slot', say: 'a slot' }
    ]
    expect(screenPlan('s#a', row({ steps }), SAMPLES)).toMatchObject({
      sample: 'empty',
      steps: [{ click: '.x-nav .x-slot' }]
    })
  })

  it('knows a control by any selector of a hidden list', () => {
    const steps = [{ click: '.x-plate [aria-label="Nothing yet"]', say: 'the switch' }]
    expect(screenPlan('s#a', row({ steps }), SAMPLES).sample).toBe('empty')
  })

  it('refuses a prototype control that names no sample set, rather than skipping it', () => {
    const steps = [{ click: '.x-controls .x-toggle[aria-label="Launch fails"]', say: 'x' }]
    expect(() => screenPlan('s#a', row({ steps }), SAMPLES)).toThrow(
      /s#a step 1 clicks a prototype control .*\.x-controls.* no stand-in/
    )
  })

  it('refuses a control after a step on the app, which a board handed in at mount cannot replay', () => {
    const steps = [
      { click: '.x-nav .x-slot', say: 'a slot' },
      { click: '.x-controls [aria-label="Nothing yet"]', say: 'the switch' }
    ]
    expect(() => screenPlan('s#a', row({ steps }), SAMPLES)).toThrow(/s#a step 2 .* before/)
  })

  it('refuses a window that does not lie on whole pixels inside the work area', () => {
    const outside = {
      name: 'Low',
      selector: '.x',
      x: 0,
      y: 700 - TASKBAR - 5,
      width: 10,
      height: 10
    }
    expect(() => screenPlan('s#a', row({ windows: [outside] }), SAMPLES)).toThrow(
      /s#a: the window Low .* outside the work area/
    )
    const fractional = { name: 'Half', selector: '.x', x: 0.5, y: 0, width: 10, height: 10 }
    expect(() => screenPlan('s#a', row({ windows: [fractional] }), SAMPLES)).toThrow(/Half/)
  })

  it('refuses a row with no window to compare', () => {
    expect(() => screenPlan('s#a', row({ windows: [] }), SAMPLES)).toThrow(/s#a .* no window/)
  })
})

describe('pickTarget', () => {
  const box = (left, top, width, height, text = '') => ({ left, top, width, height, text })

  it('clicks the centre of the one visible element, on whole pixels', () => {
    expect(pickTarget([box(0, 0, 0, 0), box(10, 20, 31, 11)], null)).toEqual({
      index: 1,
      x: 26,
      y: 26
    })
  })

  it('narrows to the element whose trimmed text is exactly the one asked for', () => {
    const found = pickTarget([box(0, 0, 10, 10, 'Go on'), box(20, 0, 10, 10, '  Go ')], 'Go')
    expect(found).toEqual({ index: 1, x: 25, y: 5 })
  })

  it('refuses none or several matches, saying how many', () => {
    expect(pickTarget([], null)).toEqual({ error: '0 visible elements match' })
    expect(pickTarget([box(0, 0, 4, 4), box(9, 9, 4, 4)], null)).toEqual({
      error: '2 visible elements match'
    })
  })
})

describe('coveredError', () => {
  it('passes a centre that lands on the element or inside it', () => {
    expect(coveredError({ inside: true, html: '<b></b>' }, 3, 4)).toBeNull()
  })

  it('names what covers the centre, or that nothing is there', () => {
    expect(coveredError({ inside: false, html: '<div class="veil">' }, 3, 4)).toBe(
      'its centre (3, 4) is covered by <div class="veil">'
    )
    expect(coveredError({ inside: false, html: null }, 3, 4)).toBe(
      'its centre (3, 4) is covered by nothing'
    )
  })
})

describe('restPoint', () => {
  const area = { width: 1000, height: 660 }
  const at = (x, width) => ({ name: 'w', selector: '.w', x, y: 0, width, height: 600 })

  it('rests the pointer in the free band beside a window docked right', () => {
    expect(restPoint(area, [at(600, 400), at(602, 398)])).toEqual({ x: 300, y: 330 })
  })

  it('rests it beyond a window docked left', () => {
    expect(restPoint(area, [at(0, 400)])).toEqual({ x: 700, y: 330 })
  })

  it('refuses a screen the windows fill, where every point would hover the app', () => {
    expect(() => restPoint(area, [at(0, 1000)])).toThrow(/no point .* outside every window/)
  })
})

describe('cropImage', () => {
  // A 3x2 RGBA image whose red channel numbers its pixels.
  const img = {
    width: 3,
    height: 2,
    data: Buffer.from([
      0, 0, 0, 255, 1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255, 4, 0, 0, 255, 5, 0, 0, 255
    ])
  }

  it('cuts one box out of an image, as compare-ref --region does', () => {
    const cut = cropImage(img, { x: 1, y: 0, width: 2, height: 2 }, 'ref.png')
    expect(cut.width).toBe(2)
    expect(cut.height).toBe(2)
    expect([...cut.data].filter((_, i) => i % 4 === 0)).toEqual([1, 2, 4, 5])
  })

  it('refuses a box that does not fit inside the image', () => {
    expect(() => cropImage(img, { x: 2, y: 0, width: 2, height: 1 }, 'ref.png')).toThrow(
      '--region 2,0,2,1 does not fit inside ref.png (3x2)'
    )
  })
})

describe('clusterSummary', () => {
  it('names the largest clusters where they lie in the window', () => {
    const found = [
      { pixels: 90, width: 10, height: 9, x: 4, y: 5 },
      { pixels: 9, width: 3, height: 3, x: 40, y: 50 },
      { pixels: 9, width: 3, height: 3, x: 70, y: 80 }
    ]
    expect(clusterSummary(found, 2)).toBe(
      '90px in 10x9 at x 4, y 5; 9px in 3x3 at x 40, y 50; and 1 more'
    )
    expect(clusterSummary([], 2)).toBe('none')
  })
})
