/**
 * The hover tooltip a card-bearing target shows (#635; components.md, Tooltip card): 300ms after
 * the pointer arrives, at once on keyboard focus, gone on leave, blur, press or Esc. A press keeps
 * it away until the pointer leaves: nothing re-arms it before then, neither the pointer resting on
 * nor the window handing the pressed target its focus back, which is what brought the map's card
 * back a second after a click (#654).
 *
 * Held by an id, so a poll replacing what the target describes keeps the card on the same thing
 * with fresh facts rather than vanishing under the pointer. Where the card goes is placeTip's; the
 * owner binds `card` to the card it draws, in <body>, and `style` to its box.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import { TIP_DELAY_MS, placeTip, type TipOptions, type TipSide } from '../lib/overlay/tipCard'

export function useHoverTip<K>(options: TipOptions = {}) {
  const shown = ref(null) as Ref<K | null>
  const card = ref<{ $el?: unknown } | HTMLElement | null>(null)
  const place = ref<{ left: number; top: number; side: TipSide }>({ left: 0, top: 0, side: 'top' })
  let target: HTMLElement | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let dismissed = false

  const style = computed(() => ({
    left: place.value.left + 'px',
    top: place.value.top + 'px',
    // It rises 6px into place above its target, and drops 6px into place below it.
    '--tip-rise': place.value.side === 'bottom' ? '-6px' : '6px'
  }))

  function clearTimer(): void {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  function cardElement(): HTMLElement | undefined {
    const value = card.value
    if (value instanceof HTMLElement) return value
    const el = (value as { $el?: unknown } | null)?.$el
    return el instanceof HTMLElement ? el : undefined
  }

  async function show(id: K, on: HTMLElement): Promise<void> {
    clearTimer()
    target = on
    shown.value = id
    await nextTick()
    const el = cardElement()
    if (!el || target !== on) return
    place.value = placeTip(
      on.getBoundingClientRect(),
      { width: el.offsetWidth, height: el.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
      options
    )
  }

  function hide(): void {
    clearTimer()
    target = null
    shown.value = null
  }

  function hover(id: K, event: PointerEvent | MouseEvent): void {
    if (dismissed) return
    const on = event.currentTarget as HTMLElement
    clearTimer()
    timer = setTimeout(() => void show(id, on), TIP_DELAY_MS)
  }

  function focus(id: K, event: FocusEvent): void {
    if (!dismissed) void show(id, event.currentTarget as HTMLElement)
  }

  // Only the pointer leaving re-arms a card a press dismissed.
  function leave(): void {
    dismissed = false
    hide()
  }

  function press(): void {
    dismissed = true
    hide()
  }

  function escape(event: KeyboardEvent): void {
    if (event.key === 'Escape' && shown.value !== null) hide()
  }

  onMounted(() => window.addEventListener('keydown', escape))
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', escape)
    hide()
  })

  return { shown, card, style, hover, focus, leave, press, hide }
}
