/*
 * The golden page's own surface (#634), driven from scripts/golden/ over the DevTools protocol.
 * It stages what a golden captures at the page position every reference was taken at, and nothing
 * else of the page paints: margins are zero and the caret is transparent, as in the design's
 * reference capture ("What a capture holds still").
 *
 * The stage framing CSS is not here. The harness reads it from the design repository at run time
 * and hands it in (PO ruling G-04, 2026-09-26); this file only positions the stage and reports
 * its box. The same goes for the sample data (G-03): the harness hands in the design's
 * sample-data.js as text, and the page runs it as the classic script it is. A specimen's captions
 * arrive the same way, as the texts of its state's anatomy tree (the design lead's ruling on the
 * tokens-port questions).
 *
 * A state is the real component on the stage with the app's own stylesheets loaded as the app
 * loads them, and nothing else: whatever differs from its reference is the component's.
 */
import '@fontsource/tiny5/400.css'
import '@fontsource/jacquard-12/400.css'
import '@fontsource-variable/pixelify-sans'
import '../assets/fonts/roboto/roboto.css'
import '../assets/base.css'
import '../assets/design-tokens.css'
import '../assets/theme.css'
import { createApp, h, nextTick, type App } from 'vue'
import { FRAME_CLOCK_KEY } from '../composables/useFramePlayer'
import { createFrameClock, type FrameClock } from '../lib/sprite/frameClock'
import type { SequencePosition } from '../lib/sprite/spriteSheet'
import PanelApp from '../App.vue'
import { goldenApi } from './api'
import { restoreLaunchView } from '../composables/useView'
import { useDwarfMessaging } from '../composables/useDwarfMessaging'
import { RENDERS, failedEchoesOf, type GoldenAttributes, type GoldenText } from './renders'
import { adaptSample, swapSample, type GoldenSample } from './sample'

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
  /** Every text the state's anatomy tree shows, in DOM order: a specimen's captions. */
  texts: GoldenText[]
  /** Every element of the state's anatomy tree with its attributes, in DOM order. */
  attributes: GoldenAttributes[]
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

/** The design's deterministic runtime (tools/snap-runtime.js), which the harness loads first. */
interface SnapRuntime {
  reset(): void
  clock(): { now: number }
}
const snap = (): SnapRuntime | undefined =>
  (window as unknown as { __snapRuntime?: SnapRuntime }).__snapRuntime

/*
 * The capture's frame clock (#635). A reference is taken after SETTLE_MS of the runtime's virtual
 * time, with its seeded Math.random, and then every looping animation is held at its first
 * keyframe (docs/README.md, What a capture holds still). So the sprites play here on that same
 * virtual time and seeded random — a dwarf found at work draws its start frame as the prototype
 * does, and its shift reaches the clip the prototype's reached — and `hold`, run once the settle
 * has passed, holds each at frame 0 of the clip it is on, as the runtime's freeze holds a loop.
 */
interface CaptureClock extends FrameClock {
  hold(): void
}

function captureFrameClock(): CaptureClock {
  const clock = createFrameClock({
    now: () => snap()?.clock().now ?? 0,
    setTimer: (run, ms) => window.setTimeout(run, ms),
    clearTimer: (handle) => window.clearTimeout(handle as number),
    hidden: () => false,
    onVisibilityChange: () => () => {},
    reducedMotion: () => false,
    onReducedMotionChange: () => () => {},
    random: () => Math.random()
  })
  const playing = new Set<{ last: SequencePosition; onFrame: (p: SequencePosition) => void }>()
  return {
    player(onFrame) {
      const entry = { last: { clip: 0, frame: 0 }, onFrame }
      const inner = clock.player((position) => {
        entry.last = position
        onFrame(position)
      })
      return {
        play(clips, options) {
          playing.add(entry)
          inner.play(clips, options)
        },
        stop() {
          playing.delete(entry)
          inner.stop()
        }
      }
    },
    dispose: () => clock.dispose(),
    hold() {
      const held = [...playing]
      clock.dispose()
      for (const entry of held) entry.onFrame({ clip: entry.last.clip, frame: 0 })
    }
  }
}

let mounted: App | null = null
let spriteClock: CaptureClock | null = null
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
// item, as the kit's component is. Every state starts from the same clock, the same random sequence
// and empty storage, and every sprite plays on the capture's frame clock (captureFrameClock).
async function mountState(frame: StateFrame): Promise<void> {
  const render = RENDERS[frame.id]
  if (!render) throw new Error('golden: renders.ts has no entry for ' + frame.id)
  if (!sample) throw new Error('golden: loadSample must run before mountState')
  const { component, props } = render(sample, frame.texts, frame.attributes)
  snap()?.reset()
  localStorage.clear()
  sessionStorage.clear()
  const stage = stageElement(frame.css, frame.x, frame.y, frame.width)
  mounted = createApp({ render: () => h(component, props) })
  spriteClock?.dispose()
  spriteClock = captureFrameClock()
  mounted.provide(FRAME_CLOCK_KEY, spriteClock)
  mounted.mount(stage)
  await nextTick()
  const root = stage.firstElementChild
  if (!(root instanceof HTMLElement)) {
    throw new Error('golden: ' + frame.id + ' rendered no element')
  }
  for (const declarations of frame.framing) root.style.cssText += ';' + declarations
}

/*
 * The full-screen goldens (#635): the real App, as the product's entry mounts it, on the bridge
 * api.ts answers from the sample, in a page the harness has sized to the app's window. Nothing
 * frames it: the page's own rules give way to the app's base.css, as in the product, and only the
 * transparent caret stays (docs/README.md, Full-screen references). Sprites play on the capture's
 * frame clock, as a kit state's do.
 */

interface SampleSet {
  id: string
  label: string
}

interface SampleSwitch {
  SAMPLES?: SampleSet[]
  useSample?: (id: string) => void
}

const dmOf = (): SampleSwitch | undefined => (window as unknown as { DM?: SampleSwitch }).DM

// The sample sets the design's sample script offers (DM.SAMPLES): what a prototype control swaps.
function sampleSets(): SampleSet[] {
  return (dmOf()?.SAMPLES ?? []).map((s) => ({ id: String(s.id), label: String(s.label) }))
}

// Swaps in one of those sets with the sample script's own switch (DM.useSample), and re-adapts.
function useSample(id: string): { mines: number; dwarfs: number } {
  const dm = dmOf()
  if (!dm?.useSample) throw new Error('golden: the sample script has no sample switch')
  dm.useSample(id)
  // The switch swaps the data under a running app; the launch the screen opened with stands.
  sample = sample === null ? adaptSample(dm) : swapSample(sample, adaptSample(dm))
  return {
    mines: sample.mines.length,
    dwarfs: sample.mines.reduce((n, m) => n + m.dwarfs.length, 0)
  }
}

async function mountScreen(): Promise<void> {
  if (!sample) throw new Error('golden: loadSample must run before mountScreen')
  clear()
  snap()?.reset()
  localStorage.clear()
  sessionStorage.clear()
  pageStyle.remove()
  const caret = document.createElement('style')
  caret.dataset.golden = ''
  caret.textContent = '*, *::before, *::after { caret-color: transparent !important; }'
  document.head.appendChild(caret)
  Object.defineProperty(window, 'api', { configurable: true, value: goldenApi(sample) })
  // As the product's entry does before it mounts the shell (#635, PANEL-QUESTIONS 25): the App
  // opens on the view the bridge answers as stored, the sample's remembered launch.
  await restoreLaunchView(window.api)
  const host = document.createElement('div')
  host.id = 'app'
  host.dataset.golden = ''
  document.body.appendChild(host)
  mounted = createApp(PanelApp)
  spriteClock?.dispose()
  spriteClock = captureFrameClock()
  mounted.provide(FRAME_CLOCK_KEY, spriteClock)
  mounted.mount(host)
  await nextTick()
  seedFailedSends(sample)
}

/*
 * The messages the sample marks failed (#635, decision log, Failed delivery), put in the delivery
 * store as the echoes a send that never reached its session leaves there: the app keeps no other
 * record of one, and the bridge answers no send, so no recipe could fail one. After the mount,
 * because the store keeps only the open chat's echoes and the App starts with none open; opening
 * that dwarf's chat keeps them, and opening any other drops them, as a real switch does.
 */
function seedFailedSends(from: GoldenSample): void {
  const { echoes } = useDwarfMessaging()
  for (const dwarf of from.mines.flatMap((m) => m.dwarfs)) {
    const failed = failedEchoesOf(from, dwarf.id)
    if (failed.length > 0) echoes[dwarf.id] = failed
  }
}

// Every element a recipe's selector matches, in document order: its box and its text.
function candidates(selector: string): {
  left: number
  top: number
  width: number
  height: number
  text: string
}[] {
  return [...document.querySelectorAll(selector)].map((el) => {
    const r = el.getBoundingClientRect()
    return {
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
      text: el.textContent ?? ''
    }
  })
}

// What lies at a click's centre: the matched element or a part of it, or what covers it.
function hitTest(
  selector: string,
  index: number,
  x: number,
  y: number
): { inside: boolean; html: string | null } {
  const el = document.querySelectorAll(selector)[index]
  const hit = document.elementFromPoint(x, y)
  if (el && hit && (hit === el || el.contains(hit))) return { inside: true, html: null }
  return { inside: false, html: hit ? hit.outerHTML.slice(0, 120) : null }
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
  measureState,
  sampleSets,
  useSample,
  mountScreen,
  candidates,
  hitTest,
  /** Holds every sprite at frame 0 of the clip it reached, once the settle's virtual time passed. */
  holdSprites: () => spriteClock?.hold()
}

declare global {
  interface Window {
    golden: typeof golden
  }
}

window.golden = golden
