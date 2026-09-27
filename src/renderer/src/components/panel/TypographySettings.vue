<script setup lang="ts">
import { ref } from 'vue'
import type { FontStyle, TypeFace, TypeRole, TypographyPreferences } from '../../types'
import { TYPE_ROLE_FACES } from '../../types'
import SelectField from '../controls/SelectField.vue'
import SettingsRow from './SettingsRow.vue'
import { fontFamilyLabel, fontFamilyReference } from '../../lib/typography/fontFamilies'
import {
  FONT_STYLE_OPTIONS,
  ROLE_ROWS,
  fontStyleSample,
  pickFontStyle,
  pickRoleFace,
  steppedFontStyle
} from '../../lib/settings/fontStyle'

/**
 * Settings › Appearance (#370, #635): the Font style list — DwarfAI, Pixel clean, Readable and
 * Custom, one row each previewing its own title, label and message faces — and, when Custom is in
 * force, one select per role under it, each listing only the faces that work in that role
 * (screens/settings.md, As built; foundations.md, Presets and Custom).
 *
 * A radiogroup moved with the arrow keys (components.md, Settings, Accessibility): an arrow picks
 * the next style, as a click would, and the focus follows it. What a press means is
 * lib/settings/fontStyle's; this only draws.
 *
 * The real enforcement is at the wire boundary all the same (see `parseTypographyPreferences`): a
 * hand-edited userData document reaches the renderer without passing through this component, so
 * leaving Tiny5 out of the Messages list here is not what keeps it out of a message.
 *
 * Presentational, like every settings piece: the stored choice arrives as a prop and the intent
 * leaves as one `change` event carrying the WHOLE choice the press asks for, so App.vue keeps
 * owning the IPC and the "render only what main verified" rule stays in exactly one place.
 */
const props = defineProps<{
  /** What main STORED, never what was last pressed. */
  preferences: TypographyPreferences
  /** True while a change is in flight; locks every row (see useTypography.applying). */
  applying: boolean
}>()

const emit = defineEmits<{
  /** The whole choice a press asks for: a style, and the faces its roles take. */
  change: [preferences: TypographyPreferences]
}>()

const list = ref<HTMLElement | null>(null)

function choose(style: FontStyle): void {
  emit('change', pickFontStyle(props.preferences, style))
}

function step(event: KeyboardEvent): void {
  const next = steppedFontStyle(props.preferences.style, event.key)
  if (next === undefined) return
  event.preventDefault()
  choose(next)
  list.value?.querySelector<HTMLElement>(`[data-id="${next}"]`)?.focus()
}

function chooseFace(role: TypeRole, face: string): void {
  emit('change', pickRoleFace(props.preferences, role, face as TypeFace))
}

const faceOptions = (role: TypeRole) =>
  TYPE_ROLE_FACES[role].map((face) => ({ value: face, label: fontFamilyLabel(face) }))
</script>

<template>
  <div class="dm-settings__type">
    <SettingsRow label="Font style" stack>
      <div
        ref="list"
        class="dm-fontstyle"
        role="radiogroup"
        aria-label="Font style"
        @keydown="step"
      >
        <button
          v-for="option in FONT_STYLE_OPTIONS"
          :key="option.id"
          class="dm-fontstyle__opt m-mat"
          :class="{ 'is-on': preferences.style === option.id }"
          type="button"
          role="radio"
          :aria-checked="preferences.style === option.id ? 'true' : 'false'"
          :tabindex="preferences.style === option.id ? 0 : -1"
          :data-id="option.id"
          :disabled="applying"
          @click="choose(option.id)"
        >
          <span class="dm-fontstyle__dot" aria-hidden="true"></span>
          <span class="dm-fontstyle__text">
            <b>{{ option.label }}</b>
            <span>{{ option.note }}</span>
          </span>
          <span class="dm-fontstyle__sample" aria-hidden="true">
            <span
              v-for="(face, index) in fontStyleSample(option.id, preferences)"
              :key="index"
              :style="{ fontFamily: fontFamilyReference(face) }"
              >Aa</span
            >
          </span>
        </button>
      </div>
    </SettingsRow>
    <template v-if="preferences.style === 'custom'">
      <SettingsRow v-for="row in ROLE_ROWS" :key="row.role" :label="row.label" :help="row.help">
        <SelectField
          held
          :class="'role-font role-font-' + row.role"
          :label="row.label + ' font'"
          :value="preferences.faces[row.role]"
          :options="faceOptions(row.role)"
          :disabled="applying"
          @update:value="chooseFace(row.role, $event)"
        />
      </SettingsRow>
    </template>
  </div>
</template>

<style scoped>
/* The design's settings.css Font style rules, rule for rule. */
.dm-fontstyle {
  display: grid;
  gap: 10px;
  width: 100%;
}
.dm-fontstyle__opt {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  min-height: 48px;
  padding: 8px 12px;
  width: 100%;
  text-align: left;
  cursor: pointer;
  border: 0;
  color: var(--ink);
  background: var(--wood-lo);
  box-shadow:
    inset 2px 2px 0 0 var(--wood),
    inset -2px -2px 0 0 var(--rock-lo);
}
.dm-fontstyle__opt:hover {
  box-shadow:
    inset 2px 2px 0 0 var(--wood),
    inset -2px -2px 0 0 var(--rock-lo),
    0 0 0 2px var(--brass-lo);
}
.dm-fontstyle__opt:active {
  transform: translateY(2px);
}
.dm-fontstyle__opt.is-on {
  background: var(--wood-hi);
  box-shadow:
    inset 2px 2px 0 0 var(--gold-hi),
    inset -2px -2px 0 0 var(--gold-lo),
    0 0 0 2px var(--gold);
}
.dm-fontstyle__opt:focus-visible {
  outline: 2px solid var(--parchment);
  outline-offset: 2px;
}
.dm-fontstyle__dot {
  width: 10px;
  height: 10px;
  background: var(--rock-lo);
  box-shadow: 0 0 0 2px var(--wood-hi);
}
.dm-fontstyle__opt.is-on .dm-fontstyle__dot {
  background: var(--brass);
  box-shadow: 0 0 0 2px var(--brass-lo);
}
.dm-fontstyle__text {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.dm-fontstyle__text b {
  font: 400 var(--fs-section) / 1.1 var(--f-label);
  color: var(--parchment);
}
.dm-fontstyle__text span {
  font: 400 var(--fs-meta) / 1.35 var(--f-meta);
  color: var(--ink-faint);
}
.dm-fontstyle__sample {
  display: flex;
  gap: 8px;
  align-items: baseline;
  font-size: var(--fs-title);
  line-height: 1;
  color: var(--gold);
}
.dm-fontstyle__sample span:nth-child(2) {
  font-size: var(--fs-section);
  color: var(--ink-soft);
}
.dm-fontstyle__sample span:nth-child(3) {
  font-size: var(--fs-body);
  color: var(--ink-soft);
}
</style>
