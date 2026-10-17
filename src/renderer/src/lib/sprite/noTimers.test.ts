import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * ISSUE-282 (TC-282-03), L7 static: one frame clock drives every sprite in a renderer, and nothing
 * else does. It reads the real renderer source on purpose — the code is the subject.
 *
 * The clock wakes on ONE timer at a time, aimed at the earliest frame change, and it gets that
 * timer from its tick source alone (tickSource.ts; why not requestAnimationFrame is written
 * there). So among the code that plays sprites, the tick source adapter is the only file allowed a
 * timer, and the frame arithmetic is read only by the clock and the pure sheet player.
 *
 * The golden capture page (`golden/**`) is a harness, not the app: it runs its own clock on the
 * capture's virtual time (golden/page.ts, captureFrameClock), and is left out.
 */
const RENDERER_SRC = fileURLToPath(new URL('../../', import.meta.url))

function sourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'golden' || entry.name === 'testing' || entry.name === 'assets') continue
      files.push(...sourceFiles(path))
    } else if (/\.(ts|vue)$/.test(entry.name) && !/\.(test|spec)\.ts$|\.d\.ts$/.test(entry.name)) {
      files.push(path)
    }
  }
  return files
}

const SOURCES = sourceFiles(RENDERER_SRC).map((path) => ({
  path: relative(RENDERER_SRC, path).split(sep).join('/'),
  text: readFileSync(path, 'utf8')
}))

// Comments explain timers without calling one; only code counts.
const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

/** The code that plays sprites: the sprite library, its composable and every sprite component. */
const SPRITE_PLAYERS = SOURCES.filter(
  ({ path }) =>
    path.startsWith('lib/sprite/') ||
    path === 'composables/useFramePlayer.ts' ||
    /^composables\/useSprite[^/]*\.ts$/.test(path) ||
    /^components\/.*Sprite[^/]*\.vue$/.test(path)
)

const TICK_SOURCE_ADAPTER = 'lib/sprite/timerTickSource.ts'

describe('noTimers', () => {
  it('[NFR-TIM-10] no setInterval or setTimeout drives sprite frames in src/renderer: only the frame clock’s tick source sets a timer', () => {
    expect(SPRITE_PLAYERS.map(({ path }) => path)).toContain('components/dwarf/SpriteStrip.vue')

    const timed = SPRITE_PLAYERS.filter(({ path }) => path !== TICK_SOURCE_ADAPTER)
      .filter(({ text }) =>
        /\b(setTimeout|setInterval|requestAnimationFrame)\s*\(/.test(code(text))
      )
      .map(({ path }) => path)
    expect(timed).toEqual([])

    const adapter = code(SOURCES.find(({ path }) => path === TICK_SOURCE_ADAPTER)!.text)
    expect(adapter.match(/\bsetTimeout\s*\(/g)).toHaveLength(1)
    expect(adapter).not.toMatch(/\b(setInterval|requestAnimationFrame)\s*\(/)
  })

  it('[NFR-TIM-10] one frame clock per renderer reads the frame arithmetic; no sprite runs a clock of its own', () => {
    const clockMakers = SOURCES.filter(({ text }) => /\bcreateFrameClock\s*\(/.test(code(text)))
      .map(({ path }) => path)
      .filter((path) => path !== 'lib/sprite/frameClock.ts')
    expect(clockMakers).toEqual(['composables/useFramePlayer.ts'])

    const frameMath = SOURCES.filter(({ text }) =>
      /\b(sequenceFrameAt|sequenceNextChangeMs|sheetFrameAt)\s*\(/.test(code(text))
    )
      .map(({ path }) => path)
      .filter((path) => path !== 'lib/sprite/spriteSheet.ts')
    expect(frameMath.sort()).toEqual(['lib/sprite/frameClock.ts', 'lib/sprite/sheetPlayer.ts'])
  })
})
