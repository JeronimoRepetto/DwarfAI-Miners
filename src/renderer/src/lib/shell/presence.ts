import { PANEL_MOTION_Y } from './panelMotion'

/**
 * The shared enter/exit vocabulary for #566 T3 — modals, popups and tooltips,
 * the surfaces the design decision after T0 names as safe for `AnimatePresence`
 * because nothing here gates window geometry: a run that hangs while the
 * window is hidden is harmless, it finishes when the window shows again. Never
 * import these into `PanelTransition`, `useShellFold`, `boundedMotion` or the
 * message surface — those stay on the bounded runner (`boundedMotion.ts`'s own
 * header explains why).
 *
 * Framework-agnostic on purpose, the same split `panelMotion.ts` and
 * `motionTiming.ts` already keep: a Vue component reads these, but nothing
 * here reads Vue. No `transition` is authored on either shape — motion-v's own
 * `getDefaultTransition` decides, the same user ruling T2 already applied to
 * the bounded runner (#566: "si vamos, cualquier cosa sino la cambiamos
 * luego"), extended here to the declarative `motion.*`/`AnimatePresence`
 * surfaces this task adds.
 */

/**
 * Modals and popups: a slight rise on the way in, the same fall on the way
 * out. `PANEL_MOTION_Y` rather than a second `12` — it is the shell's own
 * hidden offset (`panelMotion.ts`), and a popup sliding the identical distance
 * reads as one vocabulary rather than two unrelated numbers that happen to
 * agree today.
 */
export const popVariants = {
  initial: { opacity: 0, y: PANEL_MOTION_Y },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: PANEL_MOTION_Y }
} as const

/**
 * Tooltips: opacity only, no travel — the hover/focus popovers this replaces
 * (`DwarfSprite`'s `.tooltip-holder`, the map's `.mine-tooltip`) never moved,
 * only faded, and inventing a rise for them would be motion the design never
 * drew.
 */
export const fadeVariants = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 }
} as const

/**
 * The one exception to "no transition is authored" above, and why it exists.
 *
 * `<MotionConfig reduced-motion="always">` does not do what its name suggests
 * for either shape above: motion-dom's own reduced-motion gate
 * (`animation/interfaces/visual-element-target.mjs`, `effects.mjs`) only
 * swaps out `positionalKeys` — `width`/`height`/`top`/`left`/`right`/`bottom`
 * plus the transform props (`x`/`y`/`scale`/`rotate`…) — for `{ type: false }`
 * (an instant jump). `opacity` is not a positional key, so it keeps animating
 * on its own ordinary default transition, "always" and all
 * (`presence.test.ts` pins this against the real engine — RED before this
 * constant existed, confirming the finding rather than assuming it from
 * reading the source alone, the same discipline `boundedMotion.ts`'s own
 * module header holds itself to).
 *
 * The app's own acceptance bar for #566 is "state change without motion on
 * every migrated surface," and the `theme.css` blanket already gave every
 * CSS-only fade exactly that before this task touched anything (`transition-
 * duration: 0.01ms !important` under `prefers-reduced-motion: reduce`).
 * Removing a CSS transition in favour of motion-v without this constant would
 * be a regression relative to what a viewer already had: a popup or tooltip
 * that used to snap now crossfades for 300ms because it was asked for LESS
 * motion. `App.vue` and `MessagePanelWindow.vue` hand this to `<MotionConfig>`
 * as its own `transition` prop rather than each surface reading `reduced` and
 * repeating the object: a `motion.*` component with no `transition` of its
 * own inherits the config's (`motion-v`'s `resolve-motion-props.mjs`:
 * `props.transition ?? config.transition`), so one reactive value at each
 * root reaches every surface under it the same way `reducedMotion` itself
 * does — "the app asks that one query in one place" (#71), extended to what
 * the answer does once asked.
 */
export const REDUCED_MOTION_TRANSITION = { duration: 0 } as const
