/*
 * The Control-room scaling page (ISSUE-298, S-034-1): a perf-only renderer entry, never part of
 * the product. Nothing under src/ imports it and no electron-vite entry names it (R13); the perf
 * case builds it on its own (buildPage.ts) and opens it in a bare Electron window
 * (electronMain.cjs).
 *
 * `?columns=<N>&degradation=on|off`: N live mine columns side by side, four across and scrolling
 * sideways past four, each the Panel's mine column with a fixture crew; with the default
 * degradation on, a column outside the viewport pauses its sprite frame clock.
 */
import '@fontsource/tiny5/400.css'
import '@fontsource/jacquard-12/400.css'
import '@fontsource-variable/pixelify-sans'
import '../../../src/renderer/src/assets/fonts/roboto/roboto.css'
import '../../../src/renderer/src/assets/base.css'
import '../../../src/renderer/src/assets/design-tokens.css'
import '../../../src/renderer/src/assets/theme.css'
import { createApp, h, nextTick, ref } from 'vue'
import { WALK_OUT_KEY } from '../../../src/renderer/src/composables/useMines'
import ControlRoom from './ControlRoom.vue'
import { fixtureMines } from './fixtureMines'
import { createProbe } from './probe'

const params = new URLSearchParams(location.search)
const columns = Number(params.get('columns') ?? '4')
const degradation = params.get('degradation') !== 'off'

const room = ref<InstanceType<typeof ControlRoom> | null>(null)
const app = createApp({
  render: () => h(ControlRoom, { ref: room, mines: fixtureMines(columns), degradation })
})
// No dwarf leaves on this page, and no board hears of a walk-out.
app.provide(WALK_OUT_KEY, { walkingOut: () => {}, walkedOut: () => {} })
app.mount('#app')

const mosaic = (): HTMLElement => {
  const element = room.value?.mosaic
  if (!element) throw new Error('the mosaic is not mounted')
  return element
}

async function whenReady(): Promise<{
  columns: number
  columnWidth: number
  devicePixelRatio: number
}> {
  await nextTick()
  await document.fonts.ready
  await Promise.all([...document.images].map((image) => image.decode().catch(() => undefined)))
  const first = document.querySelector<HTMLElement>('.cr-slot')
  return {
    columns: document.querySelectorAll('.dm-minecol').length,
    columnWidth: first?.getBoundingClientRect().width ?? 0,
    devicePixelRatio: window.devicePixelRatio
  }
}

window.controlRoom = createProbe(mosaic, whenReady())
