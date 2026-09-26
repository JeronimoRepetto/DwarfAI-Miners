/*
 * The golden page's own surface (#634), driven from scripts/golden/ over the DevTools protocol.
 * It stages what a golden captures at the page position every reference was taken at, and nothing
 * else of the page paints: margins are zero and the caret is transparent, as in the design's
 * reference capture ("What a capture holds still").
 *
 * The stage framing CSS is not here. The harness reads it from the design repository at run time
 * and hands it in (PO ruling G-04, 2026-09-26); this file only positions the stage and reports
 * its box. The same goes for the sample data (G-03): the harness hands in the design's
 * sample-data.js as text, and the page runs it as the classic script it is.
 *
 * A state is the real component on the stage with the app's own stylesheets loaded as the app
 * loads them, and nothing else: whatever differs from its reference is the component's.
 */
import '@fontsource/tiny5/400.css'
import '@fontsource-variable/pixelify-sans'
import '../assets/fonts/roboto/roboto.css'
import '../assets/base.css'
import '../assets/design-tokens.css'
import '../assets/theme.css'
import { createApp, h, nextTick, type App } from 'vue'
import { RENDERS } from './renders'
import { adaptSample, type GoldenSample } from './sample'

export interface GoldenBox {
  x: number
  y: number
  width: number
  height: number
}

export interface StageFrame {
  css: string
  x: number
  y: number
  width: number
}

export interface StateFrame {
  id: string
  css: string
  x: number
  y: number
  /** The manifest row's stage width, or null for a stage let out to its content ("Widened"). */
  width: number | null
  /** The component's UI kit framing declarations, applied to its root element. */
  framing: string[]
}

export interface StateMeasure {
  box: GoldenBox
  /** Guess notes a build pins where no doc gave a value (the acceptance rule's third half). */
  notes: number
  /** Elements drawn outside the stage and not clipped inside it: the capture cannot show them. */
  escaped: number
  /** Elements added to the page outside the stage (a popover, a toast). */
  outside: number
}

// The app's base.css makes html and body a clipped, window-high box; a stage taller than the
// viewport must still be laid out whole for a beyond-viewport capture.
const PAGE_CSS = `
html, body { margin: 0; padding: 0; height: auto; overflow: visible; }
*, *::before, *::after { caret-color: transparent !important; }
`

let mounted: App | null = null
let sample: GoldenSample | null = null

function boxOf(element: Element): GoldenBox {
  const r = element.getBoundingClientRect()
  return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height }
}

function clear(): void {
  mounted?.unmount()
  mounted = null
  document.querySelectorAll('[data-golden]').forEach((el) => el.remove())
}

function place(element: HTMLElement, x: number, y: number): void {
  element.dataset.golden = ''
  element.style.position = 'absolute'
  element.style.left = x + 'px'
  element.style.top = y + 'px'
}

// A picture shown at its own size with its top-left corner at (x, y): the loopback calibration.
async function showImage(src: string, x: number, y: number): Promise<GoldenBox> {
  clear()
  const img = new Image()
  img.src = src
  img.style.display = 'block'
  place(img, x, y)
  await img.decode()
  document.body.appendChild(img)
  return boxOf(img)
}

function stageElement(css: string, x: number, y: number, width: number | null): HTMLElement {
  clear()
  const style = document.createElement('style')
  style.dataset.golden = ''
  style.textContent = css
  document.head.appendChild(style)
  const stage = document.createElement('div')
  stage.className = 'kit-stage'
  stage.style.boxSizing = 'border-box'
  stage.style.width = width === null ? 'max-content' : width + 'px'
  place(stage, x, y)
  document.body.appendChild(stage)
  return stage
}

// An empty UI kit stage at (x, y), `width` wide including its padding, framed by the design's CSS.
function frameStage(frame: StageFrame): GoldenBox {
  return boxOf(stageElement(frame.css, frame.x, frame.y, frame.width))
}

// Runs the design's sample-data.js as the classic script it is, on a fresh `window.DM`, and
// adapts what it defined. Returns what it found, so the harness can tell an empty sample.
function loadSample(source: string): { mines: number; dwarfs: number } {
  const w = window as unknown as { DM: unknown }
  w.DM = {}
  const script = document.createElement('script')
  script.textContent = source
  document.head.appendChild(script)
  script.remove()
  sample = adaptSample(w.DM)
  return {
    mines: sample.mines.length,
    dwarfs: sample.mines.reduce((n, m) => n + m.dwarfs.length, 0)
  }
}

// The real component for a state, mounted as the stage's only child so it is the stage's flex
// item, as the kit's component is. Every state starts from the same clock and empty storage.
async function mountState(frame: StateFrame): Promise<void> {
  const render = RENDERS[frame.id]
  if (!render) throw new Error('golden: renders.ts has no entry for ' + frame.id)
  if (!sample) throw new Error('golden: loadSample must run before mountState')
  const { component, props } = render(sample)
  const runtime = (window as unknown as { __snapRuntime?: { reset(): void } }).__snapRuntime
  runtime?.reset()
  localStorage.clear()
  sessionStorage.clear()
  const stage = stageElement(frame.css, frame.x, frame.y, frame.width)
  mounted = createApp({ render: () => h(component, props) })
  mounted.mount(stage)
  await nextTick()
  const root = stage.firstElementChild
  if (!(root instanceof HTMLElement)) {
    throw new Error('golden: ' + frame.id + ' rendered no element')
  }
  for (const declarations of frame.framing) root.style.cssText += ';' + declarations
}

// After the page has settled: puts the stage on whole pixels as the reference capture does (a
// fractional height becomes extra bottom padding, a widened stage's fractional width extra right
// padding; nothing inside moves), then reports its box and what the image could not show.
function measureState(): StateMeasure {
  const stage = document.querySelector<HTMLElement>('.kit-stage[data-golden]')
  if (!stage) throw new Error('golden: no state is mounted')
  const up = (v: number): number => Math.ceil(v) - v
  const cs = getComputedStyle(stage)
  const first = stage.getBoundingClientRect()
  if (up(first.height) > 0) {
    stage.style.paddingBottom = parseFloat(cs.paddingBottom) + up(first.height) + 'px'
  }
  if (stage.style.width === 'max-content' && up(first.width) > 0) {
    stage.style.paddingRight = parseFloat(cs.paddingRight) + up(first.width) + 'px'
  }
  const r = stage.getBoundingClientRect()
  let escaped = 0
  stage.querySelectorAll('*').forEach((el) => {
    const q = el.getBoundingClientRect()
    if (!q.width || !q.height || getComputedStyle(el).visibility === 'hidden') return
    const beyond =
      q.left < r.left - 1 || q.top < r.top - 1 || q.right > r.right + 1 || q.bottom > r.bottom + 1
    if (!beyond) return
    // Content scrolled or clipped by an ancestor inside the stage is the stage's own business.
    for (let p = el.parentElement; p && p !== stage; p = p.parentElement) {
      const o = getComputedStyle(p)
      if (o.overflow !== 'visible' || o.contain.includes('paint')) return
    }
    escaped++
  })
  const outside = [...document.body.children].filter(
    (el) => !baseline.has(el) && !(el instanceof HTMLElement && 'golden' in el.dataset)
  ).length
  return {
    box: boxOf(stage),
    notes: document.querySelectorAll('.dm-note').length,
    escaped,
    outside
  }
}

const pageStyle = document.createElement('style')
pageStyle.textContent = PAGE_CSS
document.head.appendChild(pageStyle)

// What the page holds before any state: a state's own additions to <body> count against it.
const baseline = new Set(document.body.children)

const golden = {
  ready: Promise.resolve(true),
  showImage,
  frameStage,
  loadSample,
  mountState,
  measureState
}

declare global {
  interface Window {
    golden: typeof golden
  }
}

window.golden = golden
