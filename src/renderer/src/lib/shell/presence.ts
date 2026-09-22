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
 * here reads Vue. No `transition` is authored on any shape here — motion-v's
 * own `getDefaultTransition` decides, the same user ruling T2 already applied
 * to the bounded runner (#566: "si vamos, cualquier cosa sino la cambiamos
 * luego"), extended here to the declarative `motion.*`/`AnimatePresence`
 * surfaces this task adds.
 *
 * T4 adds one more shape below, of a different kind: `pressHoverVariants` is
 * GESTURE rather than presence — what a control does under a pointer, not what
 * a surface does on the way in and out. It lives here because it lives by the
 * same rule that made this file: one vocabulary, imported, so that no control
 * ever carries a scale of its own and a correction is one edit rather than a
 * repo-wide hunt.
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

/**
 * Press and hover feedback for every control inside the panels (#566 T4).
 *
 * The keys are motion-v's own variant props (`state/utils/variant-props.mjs`
 * lists `whileHover` and `whilePress`), which is the whole reason this is one
 * object rather than two exports: a control spreads it with a single
 * `v-bind="pressHoverVariants"`, exactly as the modal roots already spread
 * `popVariants` over `initial`/`animate`/`exit`. One binding, no per-component
 * literal, and a control that has one is a control that drifted.
 *
 * The design source marks hover, focus and active states **Unspecified**
 * (`ui-rebuild`'s own "Unspecified means ask, not invent"), so the numbers are
 * deliberately the smallest thing that still reads as an answer rather than a
 * style: a hover that grows enough to say "this is the thing under you" and a
 * press that gives enough to say "and it heard you", with no colour, no shadow
 * and no travel invented alongside them. They are a placeholder for a product
 * decision, not a substitute for one — which is also why they are ONE pair,
 * changed in one place once that decision lands.
 *
 * `scale` is a transform prop, so `<MotionConfig reduced-motion="always">` at
 * both roots (#582) already swaps it for an instant jump — the one case where
 * motion-dom's reduced-motion gate does exactly what its name suggests, unlike
 * the `opacity` finding `REDUCED_MOTION_TRANSITION` above exists for. No
 * control handles reduced motion itself, and none should start.
 */
export const pressHoverVariants = {
  whileHover: { scale: 1.03 },
  whilePress: { scale: 0.96 }
} as const

/** Nothing to spread: the shape a control gets while it cannot be pressed. */
const NO_GESTURE = {} as const

/**
 * The same shape, withheld from a control that cannot be pressed.
 *
 * `disabled` is meant to be the SAME expression the control binds to its own
 * `:disabled`, written out twice on purpose — `v-bind="pressHoverUnless(adding)"`
 * beside `:disabled="adding"`. Two readings of one fact, on one screen, is what
 * stops them drifting apart; a control that grows under a cursor it will not
 * answer is a worse lie than one that simply sits there.
 *
 * It is needed because the engine does not do this for us. Neither motion-v's
 * hover feature (`features/gestures/hover/index.mjs`) nor motion-dom's own
 * `hover()` and `press()` (`gestures/hover.mjs`, `gestures/press/index.mjs`)
 * ever reads `element.disabled`: `hover()` attaches a bare `pointerenter`
 * listener, and `press()` filters only for a primary pointer and an active
 * drag. Chromium still dispatches pointer events at a disabled form control, so
 * a disabled button bound with the raw variants grows under the cursor —
 * `presence.test.ts` reproduces exactly that against the real engine rather
 * than taking the reading's word for it.
 *
 * NOT `pointer-events: none` in CSS, which would look like the same fix and is
 * not: every one of these controls explains its own refusal through a `title`,
 * and a control the pointer cannot reach has no hover line left to explain it
 * with (#217 put those sentences there). The CSS this replaces already drew
 * the line in the right place — `DwarfMessagePanel`'s own
 * `.control-attach:hover:not(:disabled)` predates the gesture by a long way.
 */
export function pressHoverUnless(disabled: boolean): typeof pressHoverVariants | typeof NO_GESTURE {
  return disabled ? NO_GESTURE : pressHoverVariants
}
