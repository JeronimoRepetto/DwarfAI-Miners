/*
 * The golden page's own surface (#634), driven from scripts/golden/ over the DevTools protocol.
 * It stages what a golden captures at the page position every reference was taken at, and nothing
 * else of the page paints: margins are zero and the caret is transparent, as in the design's
 * reference capture ("What a capture holds still").
 *
 * The stage framing CSS is not here. The harness reads it from the design repository at run time
 * and hands it in (PO ruling G-04, 2026-09-26); this file only positions the stage and reports
 * its box.
 */

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

const PAGE_CSS = `
html, body { margin: 0; padding: 0; }
*, *::before, *::after { caret-color: transparent !important; }
`

function boxOf(element: Element): GoldenBox {
  const r = element.getBoundingClientRect()
  return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height }
}

function clear(): void {
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

// An empty UI kit stage at (x, y), `width` wide including its padding, framed by the design's CSS.
function frameStage(frame: StageFrame): GoldenBox {
  clear()
  const style = document.createElement('style')
  style.dataset.golden = ''
  style.textContent = frame.css
  document.head.appendChild(style)
  const stage = document.createElement('div')
  stage.className = 'kit-stage'
  stage.style.boxSizing = 'border-box'
  stage.style.width = frame.width + 'px'
  place(stage, frame.x, frame.y)
  document.body.appendChild(stage)
  return boxOf(stage)
}

const pageStyle = document.createElement('style')
pageStyle.textContent = PAGE_CSS
document.head.appendChild(pageStyle)

const golden = { ready: Promise.resolve(true), showImage, frameStage }

declare global {
  interface Window {
    golden: typeof golden
  }
}

window.golden = golden
