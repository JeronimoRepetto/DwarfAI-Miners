/*
 * What each golden state draws (#634): the real component, with props built from the design's
 * sample data as the golden page loaded it. Keyed by the manifest key `states.json` lists; the
 * state ids are the only design text here (PO ruling G-03).
 *
 * A render reaches a state through the component's own props, exactly as the app would; it never
 * styles the component. The stage and a component's UI kit framing come from the design's docs at
 * run time, so an entry that needs a tweak to match its reference has found a gap in the
 * component, which the rebuild (#635) closes.
 *
 * The `foundations/*` states are specimens of the tokens rather than components: they draw the
 * golden-only views in specimens.ts, with the token and class lists the design's anatomy gives
 * each state, and the captions its tree shows, which the harness reads at run time and hands in as
 * `texts`. A specimen still marked `Unbuilt` has no view yet, so it fails as it should.
 */
import { defineComponent, h, type Component } from 'vue'
import ActionButton from '../components/controls/ActionButton.vue'
import TierProgress from '../components/browse/TierProgress.vue'
import TierMarker from '../components/map/TierMarker.vue'
import ChoiceChip from '../components/controls/ChoiceChip.vue'
import FieldHint from '../components/controls/FieldHint.vue'
import InputField from '../components/controls/InputField.vue'
import MetaChip from '../components/controls/MetaChip.vue'
import SelectField from '../components/controls/SelectField.vue'
import TierChip from '../components/controls/TierChip.vue'
import OreCapsule from '../components/vault/OreCapsule.vue'
import VaultStrip from '../components/vault/VaultStrip.vue'
import KeyCap from '../components/panel/KeyCap.vue'
import SettingsBanner from '../components/panel/SettingsBanner.vue'
import SettingsRow from '../components/panel/SettingsRow.vue'
import SettingsPanel from '../components/panel/SettingsPanel.vue'
import { DEFAULT_TOGGLE_ACCELERATOR } from '../../../shared/accelerator'
import CrewRoster from '../components/scene/CrewRoster.vue'
import DwarfTip from '../components/dwarf/DwarfTip.vue'
import MineColumn from '../components/scene/MineColumn.vue'
import HistoryPanel from '../components/history/HistoryPanel.vue'
import DwarfMessagePanel from '../components/message/DwarfMessagePanel.vue'
import ChatBubble from '../components/message/ChatBubble.vue'
import DwarfPermissionCard from '../components/dwarf/DwarfPermissionCard.vue'
import DwarfQuestionCard from '../components/dwarf/DwarfQuestionCard.vue'
import QuestionOption from '../components/message/QuestionOption.vue'
import MessageComposer from '../components/message/MessageComposer.vue'
import ActivityDisclosure from '../components/message/ActivityDisclosure.vue'
import { ACTIVITY_WORKING_LABEL, activityStepsLabel } from '../lib/message/activityGroup'
import { historyClock } from '../lib/history/mineHistory'
import { RETRY_TITLE, sendMarker } from '../lib/delivery/deliveryVerdict'
import { COMPOSER_HINT, bubbleMark } from '../lib/message/panelChrome'
import type { MessageEcho } from '../lib/message/echo'
import {
  ANSWERS_HEADING,
  permissionAnswerRecord,
  questionAnswersRecord
} from '../lib/question/answersRecord'
import { decisionForLabel } from '../lib/question/questionAnswer'
import AddPanel from '../components/launch/AddPanel.vue'
import { useAgentLaunch } from '../composables/useAgentLaunch'
import { OTHER_CHOICE, type LaunchChoice } from '../lib/launch/launchState'
import { goldenApi } from './api'
import SceneDwarf from '../components/scene/SceneDwarf.vue'
import { INTERIOR_SRC } from '../lib/art'
import type { Station } from '../lib/scene/mineColumn'
import ToggleSwitch from '../components/controls/ToggleSwitch.vue'
import CountBadge from '../components/dwarf/CountBadge.vue'
import DwarfPortrait from '../components/dwarf/DwarfPortrait.vue'
import StatePill from '../components/dwarf/StatePill.vue'
import VolumeSlider from '../components/controls/VolumeSlider.vue'
import NavSlot from '../components/shell/NavSlot.vue'
import SpriteStrip from '../components/dwarf/SpriteStrip.vue'
import PanelNav from '../components/shell/PanelNav.vue'
import GuildPage from '../components/shell/GuildPage.vue'
import PageHeader from '../components/shell/PageHeader.vue'
import TierInfo from '../components/browse/TierInfo.vue'
import MineCard from '../components/browse/MineCard.vue'
import MinesList from '../components/browse/MinesList.vue'
import MapPage from '../components/map/MapPage.vue'
import { mapVariantAt } from '../lib/map/mapTime'
import TooltipCard from '../components/overlay/TooltipCard.vue'
import type { MineCardState, MineCardView } from '../lib/browse/mineCard'
import DialogCard from '../components/overlay/DialogCard.vue'
import MenuButton from '../components/overlay/MenuButton.vue'
import MenuList from '../components/overlay/MenuList.vue'
import ToastCard from '../components/overlay/ToastCard.vue'
import type { MenuEntry, MenuItem } from '../lib/overlay/menu'
import type { BadgeTone, PillTone } from '../lib/dwarf/badge'
import type { PortraitStatus } from '../lib/dwarf/portrait'
import type { IconName } from '../lib/icon/iconGrids'
import { GUILD_SLOTS, SYSTEM_SLOTS, WORLD_SLOTS } from '../lib/shell/panelNav'
import { SPRITE_SHEETS, type SpriteSheetKey } from '../lib/sprite/dwarfSheets'
import {
  DEFAULT_JEV_SETTINGS,
  DEFAULT_TYPOGRAPHY_PREFERENCES,
  MATERIALS,
  type Dwarf,
  type DwarfProvider,
  type DwarfSendState,
  type DwarfRole,
  type JevRouteLaunchResult,
  type Material,
  type MaterialTotals,
  type MineTier
} from '../types'
import { at as sampleTime, silenceMs, type GoldenSample } from './sample'
import {
  EnterFrame,
  IconRow,
  IconSheet,
  KitFrame,
  KitRow,
  PlateRow,
  RuleFrame,
  SwatchSheet,
  TokenList,
  TypeScale,
  Unbuilt,
  type FramedPart,
  type GoldenText
} from './specimens'

export type { GoldenText }

/** One element of a state's anatomy tree and the attributes it prints (a placeholder, a value). */
export interface GoldenAttributes {
  element: string
  attributes: Record<string, string>
}

export interface GoldenRender {
  component: Component
  props: Record<string, unknown>
}

const swatches = (names: string[]) => (): GoldenRender => ({
  component: SwatchSheet,
  props: { names }
})
const plates =
  (classes: string[]) =>
  (_sample: GoldenSample, texts: GoldenText[]): GoldenRender => ({
    component: PlateRow,
    props: { plates: classes, texts }
  })
const unbuilt = (): GoldenRender => ({ component: Unbuilt, props: {} })

const ramp = (name: string) => [name + '-hi', name, name + '-lo']

type Render = (
  sample: GoldenSample,
  texts: GoldenText[],
  attributes: GoldenAttributes[]
) => GoldenRender

/*
 * One button of a state, as the props the app would pass. `labelled` takes the next label from the
 * state's texts, in tree order: a label is design text, so it arrives at run time with the rest
 * and is never written here. An icon-only button's `title` is its icon's own name instead: the
 * accessible name never paints, and the golden grades pixels.
 */
type ButtonSpec = Record<string, unknown> & { labelled?: boolean }

const buttonProps = (specs: ButtonSpec[], texts: GoldenText[]): Record<string, unknown>[] => {
  let next = 0
  return specs.map(({ labelled, ...props }) =>
    labelled ? { ...props, label: texts[next++]?.text ?? '' } : props
  )
}
// The kit's row of buttons: each spec one real button, side by side in the kit's own frame.
const buttonRow =
  (specs: ButtonSpec[]): Render =>
  (_sample, texts) => ({
    component: KitRow,
    props: {
      parts: buttonProps(specs, texts).map((props) => ({ component: ActionButton, props }))
    }
  })
// A state that is one button and nothing around it: the button is the stage's only child.
const button =
  (spec: ButtonSpec): Render =>
  (_sample, texts) => ({ component: ActionButton, props: buttonProps([spec], texts)[0]! })

/*
 * The form controls' design text (a placeholder, a value, an accessible name, an option) is in
 * the attributes the state's tree prints, handed in at run time like the texts. `elementsOf` picks
 * the elements of one kind, in tree order; the frame around them takes the style its own root
 * prints. A flag no attribute shows, such as a forced look or `invalid`, is the render's, as a
 * button's variant is.
 */
const elementsOf = (attributes: GoldenAttributes[], element: string): Record<string, string>[] =>
  attributes
    .filter((entry) => entry.element === element || entry.element.startsWith(element + '.'))
    .map((entry) => entry.attributes)

const framed =
  (parts: (texts: GoldenText[], attributes: GoldenAttributes[]) => FramedPart[]): Render =>
  (_sample, texts, attributes) => ({
    component: KitFrame,
    props: { style: attributes[0]?.attributes.style ?? '', parts: parts(texts, attributes) }
  })

// One field per spec, each taking its placeholder, value and disabled flag from the matching
// control of the tree, and the error hint under the last when the tree has one.
const fields = (
  specs: Record<string, unknown>[],
  { control = 'input', hint = false }: { control?: 'input' | 'textarea'; hint?: boolean } = {}
): Render =>
  framed((texts, attributes) => {
    const controls = elementsOf(attributes, control)
    const parts: FramedPart[] = specs.map((spec, i) => {
      const native = controls[i] ?? {}
      return {
        component: InputField,
        props: {
          ...spec,
          placeholder: native.placeholder ?? '',
          value: native.value ?? '',
          disabled: 'disabled' in native,
          ...(native.rows === undefined ? {} : { rows: Number(native.rows) })
        }
      }
    })
    if (hint) parts.push({ component: FieldHint, props: { error: true }, text: texts[0]?.text })
    return parts
  })

// Each select of the tree with its name, disabled flag and options, in order.
const selectsOf = (
  attributes: GoldenAttributes[]
): { label: string; disabled: boolean; options: string[] }[] => {
  const selects: { label: string; disabled: boolean; options: string[] }[] = []
  for (const { element, attributes: a } of attributes) {
    if (element.startsWith('select')) {
      selects.push({ label: a['aria-label'] ?? '', disabled: 'disabled' in a, options: [] })
    } else if (element.startsWith('option')) selects.at(-1)?.options.push(a.value ?? '')
  }
  return selects
}

// Each switch of the tree, named and set as it prints, with the look each is forced to.
const toggles = (states: (string | undefined)[] = []): Render =>
  framed((_texts, attributes) =>
    elementsOf(attributes, 'button.dm-toggle').map((button, i) => ({
      component: ToggleSwitch,
      props: {
        label: button['aria-label'] ?? '',
        on: button['aria-checked'] === 'true',
        disabled: 'disabled' in button,
        state: states[i]
      }
    }))
  )

// Each range of the tree, named and set as it prints, with the look each is forced to.
const sliders = (states: (string | undefined)[] = []): Render =>
  framed((_texts, attributes) =>
    elementsOf(attributes, 'input').map((range, i) => ({
      component: VolumeSlider,
      props: {
        label: range['aria-label'] ?? '',
        value: Number(range.value),
        disabled: 'disabled' in range,
        state: states[i]
      }
    }))
  )

// Each choice chip of the tree, its label the next text, pressed, disabled and tiered as it
// prints, with the look each is forced to.
const choiceChips = (states: (string | undefined)[] = []): Render =>
  framed((texts, attributes) =>
    elementsOf(attributes, 'button.dm-chip').map((chip, i) => ({
      component: ChoiceChip,
      props: {
        label: texts[i]?.text ?? '',
        ...(chip['aria-pressed'] === undefined ? {} : { pressed: chip['aria-pressed'] === 'true' }),
        ...(chip['data-tier'] === undefined ? {} : { tier: chip['data-tier'] as MineTier }),
        disabled: 'disabled' in chip,
        state: states[i]
      }
    }))
  )

// The modifier a tree's element carries for a block, as `span.dm-badge.dm-badge--info` carries
// `info`: a tone is a class, so it arrives with the tree like the rest of its design.
const modifierOf = (element: string, block: string): string | undefined =>
  element
    .split('.')
    .find((c) => c.startsWith(block + '--'))
    ?.slice(block.length + 2)

// Each badge of the tree, its count read back from the text it shows: "99+" is a count past 99.
const badges: Render = framed((texts, attributes) =>
  attributes
    .filter((entry) => entry.element.startsWith('span.dm-badge'))
    .map((entry, i) => {
      const shown = texts[i]?.text ?? ''
      return {
        component: CountBadge,
        props: {
          count: shown.endsWith('+') ? Number(shown.slice(0, -1)) + 1 : Number(shown),
          tone: modifierOf(entry.element, 'dm-badge') as BadgeTone | undefined
        }
      }
    })
)

/*
 * Each pill of the tree in its tone, with the needs-you plate its tree draws inside it, its mark
 * and word the next texts. An icon line prints no name a render can read, so a state's icons are
 * its render's, in tree order, as a button's are.
 */
const pills = (icons: IconName[] = []): Render =>
  framed((texts, attributes) => {
    const specs: { tone?: PillTone; ask: boolean; icon?: IconName }[] = []
    let icon = 0
    for (const { element } of attributes.slice(1)) {
      if (element.startsWith('span.dm-pill__q')) specs.at(-1)!.ask = true
      else if (element.startsWith('span.dm-pill')) {
        specs.push({ tone: modifierOf(element, 'dm-pill') as PillTone | undefined, ask: false })
      } else if (element === 'icon') specs.at(-1)!.icon = icons[icon++]
    }
    let next = 0
    return specs.map((spec) => {
      const mark = spec.ask ? texts[next++]?.text : undefined
      return {
        component: StatePill,
        props: { ...spec, ...(mark === undefined ? {} : { mark }), text: texts[next++]?.text ?? '' }
      }
    })
  })

// The state a tree's element is forced to, as `button.dm-slot.is-hover` is.
const forcedOf = (element: string): string | undefined =>
  element
    .split('.')
    .find((c) => c.startsWith('is-'))
    ?.slice(3)

/*
 * Each slot of the tree, labelled, current, pressed, warned and forced as it prints, its badge
 * the count the next badge line shows. An icon line prints no name a render can read, so the
 * state's icons are its render's, in tree order.
 */
const slots =
  (icons: IconName[]): Render =>
  (_sample, texts, attributes) => {
    const parts: FramedPart[] = []
    let badge = 0
    for (const { element, attributes: a } of attributes.slice(1)) {
      if (element.startsWith('button.dm-slot')) {
        parts.push({
          component: NavSlot,
          props: {
            icon: icons[parts.length],
            label: a['data-label'] ?? '',
            current: a['aria-current'] === 'page',
            ...(a['aria-pressed'] === undefined ? {} : { pressed: a['aria-pressed'] === 'true' }),
            warn: a['data-warn'] === 'true',
            state: forcedOf(element)
          }
        })
      } else if (element.startsWith('span.dm-badge')) {
        parts.at(-1)!.props.badge = Number(texts[badge++]?.text)
      }
    }
    return {
      component: KitFrame,
      props: { style: attributes[0]?.attributes.style ?? '', parts }
    }
  }

/*
 * Each portrait of the tree, in its status, size and forced look, a button (named, pressed) where
 * the tree draws one. Its face line prints a path, not an attribute a render can read, so the
 * state's ranks are its render's, in tree order.
 */
const portraits = (roles: DwarfRole[]): Render =>
  framed((_texts, attributes) =>
    attributes
      .filter((entry) => /^(span|button)\.dm-portrait(\.|$)/.test(entry.element))
      .map(({ element, attributes: a }, i) => ({
        component: DwarfPortrait,
        props: {
          role: roles[i],
          status: a['data-status'] as PortraitStatus,
          size: modifierOf(element, 'dm-portrait'),
          interactive: element.startsWith('button'),
          name: (a['aria-label'] ?? '').split(', ')[0],
          selected: a['aria-pressed'] === 'true',
          state: forcedOf(element)
        }
      }))
  )

/*
 * The tier progress the tree prints, in the kit's width frame: toward the tier its root names,
 * value and maximum read from the bar's own aria values; measuring where the root is a status;
 * the top tier where it carries --max, its value the number it shows.
 */
const progress: Render = framed((texts, attributes) => {
  const root = attributes.find((entry) => entry.element.startsWith('div.dm-progress'))!
  const bar = attributes.find((entry) => entry.attributes.role === 'progressbar')?.attributes
  if (root.attributes.role === 'status')
    return [{ component: TierProgress, props: { measuring: true } }]
  if (root.element.includes('dm-progress--max')) {
    const shown = texts.at(-1)?.text ?? ''
    return [
      { component: TierProgress, props: { maxTier: true, value: Number(shown.replace(/,/g, '')) } }
    ]
  }
  return [
    {
      component: TierProgress,
      props: {
        nextTier: root.attributes['data-tier'] as MineTier,
        value: Number(bar?.['aria-valuenow']),
        max: Number(bar?.['aria-valuemax'])
      }
    }
  ]
})

// One capsule as its tree names it ("Coal: 280,612"): the material and its full count.
const capsule = ({ element, attributes: a }: GoldenAttributes): Record<string, unknown> => {
  const [label = '', count = ''] = (a['aria-label'] ?? '').split(': ')
  return {
    material: label.toLowerCase() as Material,
    units: Number(count.replace(/,/g, '')),
    size: modifierOf(element, 'dm-ore') === 'lg' ? 'lg' : undefined
  }
}
const capsules = (attributes: GoldenAttributes[]): GoldenAttributes[] =>
  attributes.filter((entry) => entry.element.startsWith('span.dm-ore'))
// Every material in the kit's row, and a capsule alone as the stage's only child.
const oreRow: Render = framed((_texts, attributes) =>
  capsules(attributes).map((entry) => ({ component: OreCapsule, props: capsule(entry) }))
)
const oreAlone: Render = (_sample, _texts, attributes) => ({
  component: OreCapsule,
  props: capsule(capsules(attributes)[0]!)
})

/*
 * The markers of the tree, each inside the one-pixel point the kit places it on (a plain div
 * with the style the tree prints), all in the kit's frame: tiered, named, open, asking and
 * forced as each prints. The marker centres itself on its point.
 */
const markers: Render = (_sample, _texts, attributes) => {
  const points: FramedPart[] = []
  for (const { element, attributes: a } of attributes.slice(1)) {
    if (element === 'div') {
      points.push({ component: KitFrame, props: { style: a.style ?? '', parts: [] } })
    } else if (element.startsWith('button.dm-marker')) {
      ;(points.at(-1)!.props.parts as FramedPart[]).push({
        component: TierMarker,
        props: {
          tier: a['data-tier'] as MineTier,
          label: a['aria-label'],
          selected: a['aria-pressed'] === 'true',
          asking: element.split('.').includes('dm-marker--ask'),
          state: forcedOf(element)
        }
      })
    }
  }
  return {
    component: KitFrame,
    props: { style: attributes[0]?.attributes.style ?? '', parts: points }
  }
}

/*
 * Each sprite of the tree: its sheet the key its `data-sheet` names, its scale the `--s` its style
 * prints, mirrored or still as its classes say. The key is the design's own name for a sheet the
 * app ships; the phase the tree prints is the prototype's, and the page's stopped clock holds every
 * sprite on frame 0, as the references do.
 */
const spritesOf = (attributes: GoldenAttributes[]): FramedPart[] =>
  attributes
    .filter((entry) => /^span\.dm-sprite(\.|$)/.test(entry.element))
    .map(({ element, attributes: a }) => {
      const { sheet, once } = SPRITE_SHEETS[a['data-sheet'] as SpriteSheetKey]
      const classes = element.split('.')
      return {
        component: SpriteStrip,
        props: {
          sheet,
          once,
          scale: Number(/--s:\s*(\d+)/.exec(a.style ?? '')?.[1] ?? 1),
          flip: classes.includes('dm-sprite--flip'),
          still: classes.includes('dm-sprite--still')
        }
      }
    })
const sprites: Render = framed((_texts, attributes) => spritesOf(attributes))
const spriteAlone: Render = (_sample, _texts, attributes) => {
  const [part] = spritesOf(attributes)
  return { component: part!.component, props: part!.props }
}

const STATES = [undefined, 'hover', 'active', 'focus'] as const

/*
 * The nav as its tree prints it: the page shown is the slot marked current, the badge the text of
 * the one badge line (the only text before the lever's label), the guild group revealed when it
 * is not hidden, the music on when its toggle is pressed, and the mark, the lever and the
 * landmark's name as the tree has them.
 */
const nav: Render = (_sample, texts, attributes) => {
  const slots = elementsOf(attributes, 'button.dm-slot')
  const current = slots.find((a) => a['aria-current'] === 'page')?.['data-slot']
  const page = [...WORLD_SLOTS, ...GUILD_SLOTS, ...SYSTEM_SLOTS].find((s) => s.id === current)
  const guild = elementsOf(attributes, 'div.dm-nav__group').find((a) => a['aria-label'] === 'Guild')
  const badged = elementsOf(attributes, 'span.dm-badge').length > 0
  return {
    component: PanelNav,
    props: {
      page: page?.area ?? 'map',
      guild: guild !== undefined && !('hidden' in guild),
      badge: badged ? Number(texts[0]?.text) : 0,
      music: slots.find((a) => a['data-label'] === 'Music')?.['aria-pressed'] === 'true',
      warn: slots.some((a) => a['data-warn'] === 'true'),
      mark: elementsOf(attributes, 'button.dm-nav__mark').length > 0,
      lever: elementsOf(attributes, 'div.dm-nav__lever').length > 0,
      label: attributes[0]?.attributes['aria-label'] ?? ''
    }
  }
}

// One guild page in the frame its tree's root prints.
const guildPage =
  (feature: 'lab' | 'market' | 'laboral-union'): Render =>
  (_sample, _texts, attributes) => ({
    component: KitFrame,
    props: {
      style: attributes[0]?.attributes.style ?? '',
      parts: [{ component: GuildPage, props: { area: feature } }]
    }
  })

/*
 * The menu's rows as its tree prints them: an item per menuitem, danger and forced as its classes
 * say, its label the next text and its hint the text of its hint line; a rule per separator. An
 * icon line prints no name a render can read, so a state's icons are its render's, in tree order.
 */
const menu =
  (icons: IconName[]): Render =>
  (_sample, texts, attributes) => {
    const items: MenuEntry[] = []
    let next = 0
    let icon = 0
    for (const { element } of attributes.slice(1)) {
      const last = items.at(-1) as MenuItem | undefined
      if (element.startsWith('button.dm-menu__item')) {
        items.push({
          label: texts[next++]?.text ?? '',
          ...(element.includes('dm-menu__item--danger') ? { danger: true } : {}),
          ...(forcedOf(element) === 'hover' ? { state: 'hover' as const } : {})
        })
      } else if (element === 'icon' && last) last.icon = icons[icon++]
      else if (element.startsWith('span.dm-menu__hint') && last) last.hint = texts[next++]?.text
      else if (element.startsWith('hr.')) items.push({ separator: true })
    }
    return { component: MenuList, props: { items } }
  }

/*
 * The dialog card drawn in place: its title the name its root prints, its body the paragraph after
 * the title, and its actions the tree's buttons, each labelled with the next text; the danger
 * buttons are its danger actions. A field in the tree makes it a typed confirmation, the word read
 * from the field's placeholder, and its danger action the one the word unlocks.
 */
const dialog: Render = (_sample, texts, attributes) => {
  const root = attributes[0]!
  // The tree prints a quoted placeholder unescaped, so the word is read from the prompt instead.
  const prompt = elementsOf(attributes, 'input').length ? texts[2]?.text : undefined
  const typed = prompt === undefined ? undefined : /"(.+)"/.exec(prompt)?.[1]
  const buttons = attributes.filter((entry) => entry.element.startsWith('button.dm-btn'))
  const labels = texts.slice(-buttons.length).map((t) => t.text ?? '')
  return {
    component: DialogCard,
    props: {
      static: true,
      danger: root.element.includes('dm-dialog--danger'),
      title: root.attributes['aria-label'] ?? '',
      body: texts[1]?.text ?? '',
      ...(typed === undefined ? {} : { typed }),
      actions: buttons.map((entry, i) =>
        entry.element.includes('dm-btn--danger')
          ? { label: labels[i], variant: 'danger', ...(typed ? { confirms: true } : {}) }
          : { label: labels[i] }
      )
    }
  }
}

// The toast's plate with its one line; its icon is the render's, as an icon line names none.
const toast =
  (icon: IconName): Render =>
  (_sample, texts) => ({ component: ToastCard, props: { icon, text: texts[0]?.text ?? '' } })

/*
 * The page header as its tree prints it, in its frame: the title the heading's text, a search when
 * the tree has one, and the sort and add buttons named as they print ("Sort: <label>").
 */
const pageHeaderProps = (texts: GoldenText[], attributes: GoldenAttributes[]) => {
  const buttons = elementsOf(attributes, 'button.dm-btn')
  const sort = buttons.find((a) => a.title?.startsWith('Sort: '))
  const add = buttons.find((a) => a !== sort)
  return {
    title: texts[0]?.text ?? '',
    search: elementsOf(attributes, 'div.dm-phead__search').length > 0,
    ...(sort ? { sortLabel: sort.title!.slice('Sort: '.length) } : {}),
    ...(add ? { addLabel: add.title } : {})
  }
}
const pageHeader: Render = framed((texts, attributes) => [
  { component: PageHeader, props: pageHeaderProps(texts, attributes) }
])

/*
 * The tier explainer in the kit's wood frame, the classes and style its tree's root prints, on the
 * app's own thresholds: since PANEL-QUESTIONS 7 the reference prints the configured ones in KB, and
 * the sample's floors were only ever an illustration.
 */
const tierInfo: Render = (_sample, _texts, attributes) => {
  const root = attributes[0]!
  return {
    component: KitFrame,
    props: {
      style: root.attributes.style ?? '',
      classes: root.element.split('.').slice(1).join(' '),
      parts: [{ component: TierInfo, props: {} }]
    }
  }
}

// A small icon-only button alone, named as its tree prints it: the trigger a Live state draws.
const smallIconButton =
  (icon: IconName): Render =>
  (_sample, _texts, attributes) => ({
    component: ActionButton,
    props: { icon, size: 'sm', title: attributes[0]?.attributes.title ?? '' }
  })

/*
 * One mine card as its tree prints it, from its article line to the next one: the mine, tier,
 * state, open and needs-you flags off the article's own attributes, forced look off its classes;
 * the name off the heading's title, one capsule per ore line as it names itself, the pills of the
 * crew line in order (a needs-you pill carries its "?" plate), and the progress as its bar's own
 * aria values give it. Texts run in tree order, so the card's own are read from where it starts.
 */
interface CardSpec {
  props: Record<string, unknown>
  /** How many texts the card's tree showed, so the next card reads on from there. */
  used: number
}

function mineCardSpec(texts: GoldenText[], attributes: GoldenAttributes[]): CardSpec {
  const [article, ...rest] = attributes
  const a = article!.attributes
  // The article's own lines, up to the next card in a list.
  const end = rest.findIndex((entry) => entry.element.startsWith('article.dm-card'))
  const lines = end < 0 ? rest : rest.slice(0, end)
  const card: MineCardView = {
    id: a['data-mine'] ?? '',
    name: lines.find((l) => l.element.startsWith('h3.dm-card__name'))?.attributes.title ?? '',
    tier: a['data-tier'] as MineTier,
    measured: true,
    state: a['data-state'] as MineCardState,
    ore: lines
      .filter((l) => l.element.startsWith('span.dm-ore'))
      .map((l) => capsule(l) as { material: Material; units: number }),
    crew: [],
    needs: a['data-needs'] === 'true',
    needsCount: 0,
    enterable: true,
    removable: true
  }
  const reason = lines.find((l) => l.element.startsWith('button.dm-card__hit'))?.attributes.title
  if (reason !== undefined) card.reason = reason
  // Texts in tree order: the chip's word, the name, one per capsule, then the crew line's pills (a
  // needs-you pill shows its "?" and its words), then the progress or the note.
  let t = 2 + card.ore.length
  const next = (): string => texts[t++]?.text ?? ''
  const crewAt = lines.findIndex((l) => l.element.startsWith('div.dm-card__crew'))
  for (const { element } of lines.slice(crewAt + 1)) {
    if (!element.startsWith('span.dm-pill') || element.startsWith('span.dm-pill__q')) {
      if (!element.startsWith('span.dm-pill')) break
      continue
    }
    if (element.includes('dm-pill--needs')) {
      next()
      card.crew.push({ text: next(), tone: 'needs', ask: true })
    } else card.crew.push({ text: next() })
  }
  const progress = lines.find((l) => l.element.startsWith('div.dm-progress'))
  const bar = lines.find((l) => l.attributes.role === 'progressbar')?.attributes
  if (progress?.attributes.role === 'status') card.progress = { measuring: true }
  else if (progress?.element.includes('dm-progress--max')) {
    next()
    card.progress = { maxTier: true, value: Number(next().replace(/,/g, '')) }
  } else if (progress && bar) {
    card.progress = {
      nextTier: progress.attributes['data-tier'] as MineTier,
      value: Number(bar['aria-valuenow']),
      max: Number(bar['aria-valuemax'])
    }
    t += 3
  } else if (card.state === 'unrecorded') t += 1
  else if (card.state === 'unenterable') t += 2
  if (card.progress?.measuring) t += 2
  return {
    props: {
      card,
      open: a['data-open'] === 'true',
      ...(forcedOf(article!.element) ? { state: forcedOf(article!.element) } : {})
    },
    used: t
  }
}

const mineCard: Render = framed((texts, attributes) => [
  { component: MineCard, props: mineCardSpec(texts, attributes.slice(1)).props }
])

/*
 * The Mines page as its tree prints it, in its frame: every card its list draws, in tree order and
 * each read as a mine card state is, the open one the card the tree marks open. The texts before
 * the first card are the page header's title and the chips' words, the page's own.
 */
const minesList: Render = framed((texts, attributes) => {
  const cards: MineCardView[] = []
  let openId: string | null = null
  let t = 1 + elementsOf(attributes, 'button.dm-chip').length
  attributes.forEach((entry, i) => {
    if (!entry.element.startsWith('article.dm-card')) return
    const { props, used } = mineCardSpec(texts.slice(t), attributes.slice(i))
    const card = props.card as MineCardView
    if (card.progress?.value !== undefined) card.score = card.progress.value
    cards.push(card)
    if (props.open) openId = card.id
    t += used
  })
  return [{ component: MinesList, props: { cards, openId, search: '', tier: null, sort: 'tier' } }]
})

/*
 * The Map page as its tree prints it, in its frame: the sample's mines whose markers the tree
 * draws, each marker naming its mine ("<name>, <Tier>[, needs you]"), the pressed one the open
 * mine. The totals are the sample's ore summed per material over those mines, each material its
 * own counter, never across materials, as the design's oreTotals does. The painting is the capture
 * clock's, through the app's own rule (design lead ruling 2026-09-27, PANEL-QUESTIONS 26): the
 * prototype reads the local hour as mapVariantAt does, and the harness holds Date at the capture's
 * 10:30 in its zone, so both draw the morning painting. It stood forced to the day painting until
 * the prototype adopted the rule.
 */
const mapPage: Render = (sample, _texts, attributes) => {
  const markers = elementsOf(attributes, 'button.dm-marker')
  const named = (label: string | undefined): string => (label ?? '').split(', ')[0] ?? ''
  const mines = markers.map((marker) => {
    const found = sample.mines.find((m) => m.name === named(marker['aria-label']))
    if (!found) throw new Error('golden: the sample has no mine for ' + marker['aria-label'])
    return found
  })
  const materials = Object.fromEntries(
    MATERIALS.map((material) => [
      material,
      mines.reduce((sum, m) => sum + (m.materials?.[material] ?? 0), 0)
    ])
  ) as MaterialTotals
  const open = markers.find((marker) => marker['aria-pressed'] === 'true')
  return {
    component: KitFrame,
    props: {
      style: attributes[0]?.attributes.style ?? '',
      parts: [
        {
          component: MapPage,
          props: {
            mines,
            materials,
            openId: open ? (mines[markers.indexOf(open)]?.id ?? null) : null,
            variant: mapVariantAt(new Date())
          }
        }
      ]
    }
  }
}

/*
 * The mine tooltip card as its tree prints it: the tier its chip carries, then the texts in tree
 * order — the chip's word, the name, and each row's label and value.
 */
const mineTooltip: Render = (_sample, texts, attributes) => {
  const tier = elementsOf(attributes, 'span.dm-tier')[0]?.['data-tier'] as MineTier | undefined
  const [, title, ...facts] = texts.map((t) => t.text ?? '')
  const rows = []
  for (let i = 0; i + 1 < facts.length; i += 2)
    rows.push({ label: facts[i]!, value: facts[i + 1]! })
  return { component: TooltipCard, props: { tier, title, rows } }
}

/*
 * The vault strip as its tree prints it: one capsule per ore line as it names itself, the label
 * its label line shows, on the wood plate where its root carries --plate, at the vault size where
 * its capsules carry --lg.
 */
const vaultStrip: Render = (_sample, texts, attributes) => {
  const root = attributes[0]!
  const ore = capsules(attributes).map(capsule)
  const labelled = elementsOf(attributes, 'span.dm-vault__label').length > 0
  return {
    component: VaultStrip,
    props: {
      ore: ore.map(({ material, units }) => ({ material, units })),
      plate: root.element.includes('dm-vault--plate'),
      ...(labelled ? { label: texts[0]?.text ?? '' } : {}),
      ...(ore.some((o) => o.size === 'lg') ? { size: 'lg' } : {})
    }
  }
}

/*
 * A dwarf's state as the tree prints it (`data-status`), in the wire's own words: asking is a
 * permission it holds open (a proven ask), asleep a session at rest, idle one on its way out.
 */
const WIRE_STATUS: Record<string, Pick<Dwarf, 'status' | 'waitingReason'>> = {
  working: { status: 'working' },
  asking: { status: 'waiting', waitingReason: 'approval' },
  asleep: { status: 'waiting' },
  idle: { status: 'leaving' }
}
const SEND_STATE: Record<string, DwarfSendState> = {
  pending: { phase: 'sending' },
  delivered: { phase: 'delivered' },
  reacted: { phase: 'reacted' },
  failed: { phase: 'failed' }
}
function fail(what: string, value: unknown): never {
  throw new Error('golden: no mapping for ' + what + ' ' + JSON.stringify(value))
}
const dwarfOf = (id: string, name: string, role: DwarfRole, status: string): Dwarf => ({
  id,
  sessionId: id,
  name,
  role,
  provider: 'claude',
  ...(WIRE_STATUS[status] ?? fail('status', status))
})
const percentOf = (style: string | undefined, name: string): number =>
  Number(new RegExp('--' + name + ':\\s*([\\d.]+)%').exec(style ?? '')?.[1])
/*
 * Each dwarf of the tree as it prints itself: its button's id, state, station, selection, forced
 * look and mark, its name the tag's text, its rank the one its sprite's sheet names, and its
 * facing whether that sprite is mirrored.
 */
interface TreeDwarf {
  dwarf: Dwarf
  station: Station
  selected: boolean
  hover: boolean
  mark?: string
}
function treeDwarfs(texts: GoldenText[], attributes: GoldenAttributes[]): TreeDwarf[] {
  const found: TreeDwarf[] = []
  let t = 0
  for (const { element, attributes: a } of attributes) {
    if (element.startsWith('button.dm-dwarf')) {
      found.push({
        dwarf: dwarfOf(a['data-dwarf'] ?? '', '', 'worker', a['data-status'] ?? ''),
        station: { x: percentOf(a.style, 'x'), y: percentOf(a.style, 'y'), facesLeft: true },
        selected: a['aria-pressed'] === 'true',
        hover: forcedOf(element) === 'hover',
        mark: a['data-mark']
      })
    } else if (element.startsWith('span.dm-dwarf__tag')) {
      // The texts before the tag are the "?", the "z", and a mark's glyph when it has one.
      const last = found.at(-1)!
      t += 2 + (last.mark === undefined ? 0 : 1)
      last.dwarf.name = texts[t++]?.text ?? ''
    } else if (element.startsWith('span.dm-sprite')) {
      const last = found.at(-1)!
      last.dwarf.role = (a['data-sheet'] ?? '').split('/')[0] as DwarfRole
      last.station.facesLeft = !element.split('.').includes('dm-sprite--flip')
    }
  }
  return found
}

/*
 * The dwarf states: each dwarf on the kit's scene. The scene's painting is the render's, the app's
 * own for the tier its file names: the tree cuts a style holding a quoted URL short.
 */
const dwarfScene =
  (tier: MineTier): Render =>
  (_sample, texts, attributes) => ({
    component: KitFrame,
    props: {
      classes: 'kit-scene',
      style: 'background-image: url("' + INTERIOR_SRC[tier] + '")',
      parts: treeDwarfs(texts, attributes).map(({ dwarf, station, selected, hover, mark }) => ({
        component: SceneDwarf,
        props: {
          dwarf,
          ...station,
          selected,
          ...(hover ? { state: 'hover' } : {}),
          ...(mark === undefined ? {} : { sendState: SEND_STATE[mark] })
        }
      }))
    }
  })

// The tooltip card with a dwarf's body in it, the card being the stage's only child.
const TipCard = defineComponent({
  props: { dwarf: { type: Object as () => Dwarf, required: true } },
  setup(props) {
    return () => h(TooltipCard, null, () => h(DwarfTip, { dwarf: props.dwarf }))
  }
})

/*
 * The dwarf tooltip card as its tree prints it: its lines are the last six texts (a face's mark
 * glyph may come before them) — the name, the rank, the provider, the model and effort, the
 * silence and the status — and the state its status line carries. The rank's face is the
 * render's, as a portrait's is.
 */
const dwarfTooltip =
  (role: DwarfRole): Render =>
  (_sample, texts, attributes) => {
    const [name, , provider, tuning, silence] = texts.slice(-6).map((t) => t.text ?? '')
    const [model, effort] = (tuning ?? '').split(' · ')
    const status = elementsOf(attributes, 'span.dm-dtip__status')[0]?.['data-status'] ?? ''
    const dwarf: Dwarf = {
      ...dwarfOf('tip', name ?? '', role, status),
      provider: (provider ?? '').toLowerCase() as DwarfProvider,
      model,
      effort: effort?.replace(/ effort$/, ''),
      silentForMs: silenceMs(/silent (\S+)/.exec(silence ?? '')?.[1] ?? '')
    }
    return { component: TipCard, props: { dwarf } }
  }

/*
 * The roster as its tree prints it, in the kit's wood frame: one dwarf per portrait, named,
 * stated and selected as each prints, and as many more as its +N names. The ranks are the
 * render's, as a portrait's face prints none a render can read.
 */
const crewRoster =
  (roles: DwarfRole[]): Render =>
  (_sample, _texts, attributes) => {
    const root = attributes[0]!
    const portraits = elementsOf(attributes, 'button.dm-portrait')
    const dwarfs = portraits.map((a, i) =>
      dwarfOf(
        a['data-dwarf'] ?? '',
        (a['aria-label'] ?? '').split(', ')[0] ?? '',
        roles[i] ?? fail('rank', i),
        a['data-status'] ?? ''
      )
    )
    const moreLabel = elementsOf(attributes, 'button.dm-roster__more')[0]?.['aria-label'] ?? ''
    const more = Number(/^(\d+)/.exec(moreLabel)?.[1] ?? 0)
    for (let i = 0; i < more; i++) dwarfs.push(dwarfOf('more' + i, 'more' + i, 'worker', 'working'))
    const selected = portraits.find((a) => a['aria-pressed'] === 'true')?.['data-dwarf'] ?? null
    return {
      component: KitFrame,
      props: {
        style: root.attributes.style ?? '',
        classes: root.element.split('.').slice(1).join(' '),
        parts: [{ component: CrewRoster, props: { dwarfs, selectedId: selected } }]
      }
    }
  }

/*
 * The mine column as its tree prints it, in the frame its root prints (the shell's height): the
 * sample's mine its section names, each dwarf on the station its button prints and facing as its
 * sprite does, the pressed one selected, the ambience as the section says.
 */
const mineColumn: Render = (sample, texts, attributes) => {
  const section = elementsOf(attributes, 'section.dm-minecol')[0] ?? {}
  const mine =
    sample.mines.find((m) => m.id === section['data-mine']) ?? fail('mine', section['data-mine'])
  const placed = treeDwarfs(texts, attributes)
  return {
    component: KitFrame,
    props: {
      style: attributes[0]?.attributes.style ?? '',
      parts: [
        {
          component: MineColumn,
          props: {
            mine,
            stations: Object.fromEntries(placed.map((p) => [p.dwarf.id, p.station])),
            selectedId: placed.find((p) => p.selected)?.dwarf.id ?? null,
            ambienceMuted: section['data-ambience'] === 'off'
          }
        }
      ]
    }
  }
}

/*
 * The mine history as its tree prints it, in the frame its root prints: the sample's mine its
 * title names, with the history its dwarfs' conversations would give (sample.ts).
 */
const historyPanel: Render = (sample, _texts, attributes) => {
  const label = elementsOf(attributes, 'section.dm-hist')[0]?.['aria-label'] ?? ''
  const name = label.replace(/^Mine history, /, '')
  const mine = sample.mines.find((m) => m.name === name) ?? fail('mine', name)
  return {
    component: KitFrame,
    props: {
      style: attributes[0]?.attributes.style ?? '',
      parts: [
        {
          component: HistoryPanel,
          props: {
            mine,
            history: sample.histories[mine.id],
            failed: sample.failedSends[mine.id] ?? {}
          }
        }
      ]
    }
  }
}

/*
 * The messages of a dwarf the sample marks failed, as the echoes the panel draws them from
 * (#635, decision log, Failed delivery): the delivery store's own record of a send that never
 * reached its session, which no transcript holds. Ids are the golden's own; the words and the
 * time are the sample's (sample.ts, failedSends).
 */
export function failedEchoesOf(sample: GoldenSample, dwarfId: string): MessageEcho[] {
  const sends = sample.mines.flatMap((m) => sample.failedSends[m.id]?.[dwarfId] ?? [])
  return sends.map((send, i) => ({
    id: 'golden-failed-' + i,
    text: send.text,
    sentAt: send.sentAt,
    state: { phase: 'failed' as const }
  }))
}

/*
 * The MessagePanel as its tree prints it (#635): the sample dwarf its section names, with the feed
 * main would answer for it (sample.ts), and the messages the sample marks failed as the echoes
 * the panel keeps for them (failedEchoesOf). Nothing else has been sent from the panel. A tree
 * whose message box is disabled is that dwarf once its route for text went away (decision log,
 * Copy alone on a closed session): the board's dwarf carries no delivery channel any more, and the
 * host's store, which saw it with one, says its route is gone.
 */
const messagePanel: Render = (sample, texts, attributes) => {
  const id = elementsOf(attributes, 'section.dm-msg')[0]?.['data-dwarf'] ?? ''
  const found = sample.mines.flatMap((m) => m.dwarfs).find((d) => d.id === id) ?? fail('dwarf', id)
  const routeGone = elementsOf(attributes, 'textarea').some((box) => 'disabled' in box)
  const dwarf = routeGone ? { ...found, textDelivery: undefined } : found
  return {
    component: DwarfMessagePanel,
    props: {
      dwarf,
      routeGone,
      feed: sample.feeds[dwarf.id],
      echoes: [...failedEchoesOf(sample, dwarf.id), ...answersRecordsOf(dwarf, texts, attributes)]
    }
  }
}

/*
 * The "Answers:" records a MessagePanel tree prints (#635; decision log, Answers bubble is a
 * record), as the echoes the panel keeps for them: the record of an answer that went out on the
 * ask's own channel, which no transcript holds. Its words are built as the app builds them, by
 * lib/question/answersRecord, from the dwarf's own ask and the answers the tree's list prints in
 * bold, one per step; its time is the text after it, on the sample's day; its mark is the phase
 * its `data-mark` names.
 */
function answersRecordsOf(
  dwarf: Dwarf,
  texts: GoldenText[],
  attributes: GoldenAttributes[]
): MessageEcho[] {
  const marks: (string | undefined)[] = []
  for (const { element, attributes: printed } of attributes) {
    if (element.startsWith('div.dm-bubble.')) marks.push(undefined)
    else if (element === 'span.dm-bubble__mark') marks[marks.length - 1] = printed['data-mark']
  }
  const bubbles = texts.flatMap((entry, i) =>
    entry.html === undefined ? [] : [{ html: entry.html, time: texts[i + 1]?.text }]
  )
  const read = document.createElement('template')
  return bubbles.flatMap((bubble, i) => {
    read.innerHTML = bubble.html
    if (read.content.querySelector('p')?.textContent !== ANSWERS_HEADING) return []
    const answers = [...read.content.querySelectorAll('li strong')].map((b) => b.textContent ?? '')
    const phase = PHASE_OF_MARK[marks[i] ?? ''] ?? fail('mark', marks[i])
    return [
      {
        id: 'golden-answers-' + i,
        text: recordOf(dwarf, answers),
        sentAt: sampleTime(bubble.time),
        state: { phase },
        answers: true as const
      }
    ]
  })
}

/** The record the app draws for these answers to the dwarf's own ask or permission. */
function recordOf(dwarf: Dwarf, answers: string[]): string {
  if (dwarf.pendingQuestion !== undefined)
    return questionAnswersRecord(dwarf.pendingQuestion, answers)
  const decision = decisionForLabel(answers[0] ?? '')
  if (dwarf.pendingPermission === undefined || decision === null) return fail('ask', dwarf.id)
  return permissionAnswerRecord(dwarf.pendingPermission, decision)
}

/*
 * The question card as its tree prints it (#635), in the kit's wood frame its root prints: the
 * sample dwarf the card is named for, asking what the sample asks it. A permission's card (its
 * request block in the tree) draws that dwarf's pending permission, or the sample's long request
 * when the block prints another text. The step count opens the card on the step it names, and a
 * later step opens with each step before it answered with its first option: the tree shows those
 * answers only as done dots, which any option draws alike.
 */
const questionCard: Render = (sample, texts, attributes) => {
  const root = attributes[0]!
  const label = elementsOf(attributes, 'section.dm-qcard')[0]?.['aria-label'] ?? ''
  const name = label.replace(/ is asking$/, '')
  const dwarf =
    sample.mines.flatMap((m) => m.dwarfs).find((d) => d.name === name) ?? fail('dwarf', name)
  const frame = {
    style: root.attributes.style ?? '',
    classes: root.element.split('.').slice(1).join(' ')
  }
  if (elementsOf(attributes, 'pre.dm-qcard__req').length > 0) {
    const own = dwarf.pendingPermission ?? fail('permission', name)
    const permission = texts.some((t) => t.text === `${own.toolName} · ${own.input}`)
      ? own
      : (sample.longPermissionRequest ?? fail('long request', name))
    return {
      component: KitFrame,
      props: { ...frame, parts: [{ component: DwarfPermissionCard, props: { permission, name } }] }
    }
  }
  const question = dwarf.pendingQuestion ?? fail('question', name)
  const count = texts.map((t) => /^(\d+) \/ \d+$/.exec(t.text ?? '')).find((m) => m !== null)
  const at = Number(count?.[1] ?? 1) - 1
  const answers = question.questions.slice(0, at).map((q) => q.options[0]?.label ?? '')
  return {
    component: KitFrame,
    props: {
      ...frame,
      parts: [{ component: DwarfQuestionCard, props: { question, name, at, answers } }]
    }
  }
}

/*
 * Question options as their tree prints them (#635, molecules/question-option), in the kit's
 * column frame: each row's label is its text, and its index, whether it is picked, the Other
 * thing… row and a forced look are what its element and attributes print. The number key each
 * row shows is its index plus one, so the texts that are only digits are the keys, not labels.
 */
const questionOptions: Render = (_sample, texts, attributes) => {
  const labels = texts.map((t) => t.text ?? '').filter((text) => !/^\d+$/.test(text))
  const rows = attributes.filter((entry) => entry.element.startsWith('button.dm-qopt'))
  return {
    component: KitFrame,
    props: {
      style: attributes[0]?.attributes.style ?? '',
      parts: rows.map(({ element, attributes: printed }, i) => ({
        component: QuestionOption,
        props: {
          label: labels[i] ?? fail('option label', i),
          index: Number(printed['data-index']),
          checked: printed['aria-checked'] === 'true',
          other: element.includes('.dm-qopt--other'),
          state: forcedOf(element)
        }
      }))
    }
  }
}

// The delivery phase each mark the tree prints stands for, as the panel's own store names it.
const PHASE_OF_MARK: Record<string, DwarfSendState['phase']> = {
  pending: 'sending',
  delivered: 'delivered',
  reacted: 'reacted',
  failed: 'failed'
}

/*
 * Your messages as their tree prints them (#635, molecules/chat-bubble), in the kit's column
 * frame: each bubble's words are its printed HTML read back as text, which is the message itself
 * for the one-paragraph texts these states print; its time is the text after them; its mark is
 * the phase its `data-mark` names, drawn by the panel's own reading of that phase; and a bubble
 * whose tree holds the actions group is one its host offers Retry and Copy on, as a failed echo's
 * panel does — or, when the group holds no Retry, one whose session can no longer take text, which
 * keeps Copy alone (decision log, Copy alone on a closed session).
 */
const userBubbles: Render = (_sample, texts, attributes) => {
  const bubbles: { mark?: string; actions: boolean; retry: boolean }[] = []
  for (const { element, attributes: printed } of attributes) {
    if (element.startsWith('div.dm-bubble.')) bubbles.push({ actions: false, retry: false })
    else if (element === 'span.dm-bubble__mark') bubbles.at(-1)!.mark = printed['data-mark']
    else if (element.startsWith('div.dm-bubble__actions')) bubbles.at(-1)!.actions = true
    else if (element.startsWith('button.dm-btn') && printed.title === RETRY_TITLE)
      bubbles.at(-1)!.retry = true
  }
  const bodies = texts.flatMap((entry, i) =>
    entry.html === undefined ? [] : [{ html: entry.html, time: texts[i + 1]?.text }]
  )
  const read = document.createElement('template')
  return {
    component: KitFrame,
    props: {
      style: attributes[0]?.attributes.style ?? '',
      parts: bubbles.map((bubble, i) => {
        read.innerHTML = bodies[i]?.html ?? ''
        const phase = PHASE_OF_MARK[bubble.mark ?? ''] ?? fail('mark', bubble.mark)
        return {
          component: ChatBubble,
          props: {
            from: 'user',
            text: read.content.textContent ?? '',
            time: bodies[i]?.time,
            mark: bubbleMark(sendMarker({ phase })!),
            offersRetry: bubble.actions && bubble.retry,
            sessionClosed: bubble.actions && !bubble.retry
          }
        }
      })
    }
  }
}

/*
 * A dwarf's bubble as its tree prints it (#635, molecules/chat-bubble): the tree prints the words
 * as HTML, so the message is found in the sample's feeds instead, the one thing a dwarf said at the
 * time the tree prints, and drawn from its own Markdown by the panel's bubble. Two such messages
 * would be ambiguous, and the render refuses rather than pick one.
 */
const dwarfBubble: Render = (sample, texts, attributes) => {
  const time = texts.find((entry) => entry.html === undefined)?.text ?? fail('time', texts)
  const said = Object.values(sample.feeds).flatMap((feed) =>
    feed.readable
      ? feed.messages.filter(
          (m) =>
            m.role === 'assistant' &&
            m.activity === undefined &&
            historyClock(Date.parse(m.timestamp ?? '')) === time
        )
      : []
  )
  if (said.length !== 1) fail('dwarf message at', time)
  return {
    component: KitFrame,
    props: {
      style: attributes[0]?.attributes.style ?? '',
      parts: [{ component: ChatBubble, props: { from: 'agent', text: said[0]!.text, time } }]
    }
  }
}

/*
 * One run of tool steps as its tree prints it (#635, molecules/activity): its steps are the list's
 * lines, open as the toggle's aria-expanded says and forced as its classes say. The label is the
 * panel's own reading, never the tree's words: the tree only says which run this is, an open run
 * the dwarf is still adding to ("Working...") or a closed one.
 */
const activityRun: Render = (_sample, texts, attributes) => {
  const toggle =
    attributes.find((entry) => entry.element.startsWith('button.dm-activity__toggle')) ??
    fail('activity toggle', attributes)
  const [label, ...steps] = texts.map((entry) => entry.text ?? '')
  const working = label === ACTIVITY_WORKING_LABEL
  const state = forcedOf(toggle.element)
  return {
    component: KitFrame,
    props: {
      style: attributes[0]?.attributes.style ?? '',
      parts: [
        {
          component: ActivityDisclosure,
          props: {
            label: working ? ACTIVITY_WORKING_LABEL : activityStepsLabel(steps.length),
            open: toggle.attributes['aria-expanded'] === 'true',
            lines: steps.map((text, i) => ({ key: 'step-' + i, text })),
            ...(state === undefined ? {} : { state })
          }
        }
      ]
    }
  }
}

/*
 * The composer as its tree prints it (#635, molecules/composer), in the kit's wood frame, the
 * classes and style its root prints: the well's placeholder and whether it takes text, Attach and
 * Send live or not, as their buttons print them. Nothing is typed and nothing attached. The hint is
 * the panel's own line with nothing else to say, never the tree's words.
 */
const composer: Render = (_sample, _texts, attributes) => {
  const root = attributes[0] ?? fail('composer frame', attributes)
  const well = elementsOf(attributes, 'textarea')[0] ?? fail('composer well', attributes)
  const attach = elementsOf(attributes, 'button.dm-btn.m-mat.dm-btn--icon')[0] ?? {}
  const send = elementsOf(attributes, 'button.dm-btn.m-mat.dm-btn--primary')[0] ?? {}
  return {
    component: KitFrame,
    props: {
      style: root.attributes.style ?? '',
      classes: root.element.split('.').slice(1).join(' '),
      parts: [
        {
          component: MessageComposer,
          props: {
            value: '',
            placeholder: well.placeholder ?? '',
            disabled: 'disabled' in well,
            canAttach: !('disabled' in attach),
            ...(attach.title === undefined ? {} : { attachTitle: attach.title }),
            canSend: !('disabled' in send),
            hint: COMPOSER_HINT
          }
        }
      ]
    }
  }
}

/*
 * The Add panel as its tree prints it (#635): the real launch composable opened on the mine its
 * name gives, over the bridge answered from the sample, with the supplier its checked chip names
 * chosen, as a person's click would choose it. Each prop is what App hands the panel from it.
 */
/*
 * A launch routed through Jev, as its tree prints it: the prompt, Jev's pick, and whether the
 * launch it confirmed is in flight. The tree names only the pick, so the rest of Jev's answer is
 * the least the wire allows: no confidence, and each part answered.
 */
interface JevLaunch {
  prompt: string
  pick: { provider: DwarfProvider; model: string; effort: string }
  inFlight: boolean
}

const LaunchStage = defineComponent({
  props: {
    sample: { type: Object as () => GoldenSample, required: true },
    mineId: { type: String, required: true },
    mineName: { type: String, required: true },
    choice: { type: String as () => LaunchChoice | null, default: null },
    jevLaunch: { type: Object as () => JevLaunch | null, default: null }
  },
  setup(props) {
    // The kit draws Jev as a choice the person can make, which is the app with a TypeSafe key set:
    // the bridge answers the stored verdict main keeps once one is (#509).
    const api = goldenApi(props.sample)
    const jevLaunch = props.jevLaunch
    // A launch in flight is one whose session never answers: the golden stops the world there.
    const never = (): Promise<never> => new Promise<never>(() => {})
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...api,
        getJevSettings: () => Promise.resolve({ ...DEFAULT_JEV_SETTINGS, configured: true }),
        ...(jevLaunch === null
          ? {}
          : {
              routeJevLaunch: (): Promise<JevRouteLaunchResult> =>
                Promise.resolve({
                  kind: 'decision',
                  ...jevLaunch.pick,
                  truncated: false,
                  tier: 'balanced',
                  parts: {
                    provider: {
                      value: jevLaunch.pick.provider,
                      confidence: 1,
                      applied: 'answered'
                    },
                    tier: { value: 'balanced', confidence: 1, applied: 'answered' },
                    trivial: { value: false, probability: 0 },
                    largeContext: { value: false, probability: 0 },
                    model: { value: jevLaunch.pick.model, applied: 'only-candidate' }
                  }
                }),
              launchAgent: never,
              launchHeldSession: never,
              launchHostedProcess: never
            })
      }
    })
    const launch = useAgentLaunch()
    launch.close()
    void launch.open(props.mineId).then(async () => {
      if (props.choice !== null) launch.choose(props.choice)
      if (jevLaunch === null) return
      // As a person reaches it: Let Jev choose, the prompt, Send (Jev asked, its card shown),
      // and, in flight, Send again on the pick it applied.
      launch.toggleJevEnabled()
      launch.setPrompt(jevLaunch.prompt)
      await launch.submit()
      if (jevLaunch.inFlight) void launch.submit()
    })
    return () =>
      h(AddPanel, {
        mineName: props.mineName,
        chips: launch.chips.value,
        phase: launch.phase.value,
        enabled: launch.enabled.value,
        command: launch.state.value.command,
        prompt: launch.state.value.prompt,
        refusal: launch.refusal.value,
        error: launch.state.value.error,
        modelPicker: launch.modelPicker.value,
        effortPicker: launch.effortPicker.value,
        permissionsVisible: launch.permissionsVisible.value,
        jev: launch.jev.value
      })
  }
})

/*
 * Jev's launch as the tree prints it, or null with Let Jev choose off: the prompt its field holds,
 * the pick its card names as "supplier · model · effort" (the supplier by the chip of that label),
 * and in flight when the prompt is disabled, which only a launch under way does to it.
 */
const jevLaunchOf = (texts: GoldenText[], attributes: GoldenAttributes[]): JevLaunch | null => {
  const toggle = elementsOf(attributes, 'button.dm-toggle').find(
    (a) => a['aria-label'] === 'Let Jev choose'
  )
  if (toggle?.['aria-checked'] !== 'true') return null
  const field = elementsOf(attributes, 'textarea')[0] ?? fail('prompt', 'textarea')
  const pick = texts.map((t) => /^(.+) · (.+) · (.+)$/.exec(t.text ?? '')).find((m) => m !== null)
  if (pick === undefined || pick === null) return fail('Jev pick', texts)
  const supplier = pick[1]!.toLowerCase()
  const chip = elementsOf(attributes, 'button.dm-chip').find((a) => a['data-value'] === supplier)
  const provider = (chip?.['data-value'] ?? fail('supplier', pick[1])) as DwarfProvider
  return {
    prompt: field.value ?? '',
    pick: { provider, model: pick[2]!, effort: pick[3]! },
    inFlight: 'disabled' in field
  }
}

const addPanel: Render = (sample, texts, attributes) => {
  const label = elementsOf(attributes, 'section.dm-add')[0]?.['aria-label'] ?? ''
  const name = label.replace(/^Add a dwarf to /, '')
  const mine = sample.mines.find((m) => m.name === name) ?? fail('mine', name)
  const checked = elementsOf(attributes, 'button.dm-chip').find((a) => a['aria-checked'] === 'true')
  const value = checked?.['data-value']
  const choice = value === undefined ? null : value === 'other' ? OTHER_CHOICE : value
  const jevLaunch = jevLaunchOf(texts, attributes)
  return {
    component: KitFrame,
    props: {
      style: attributes[0]?.attributes.style ?? '',
      parts: [
        {
          component: LaunchStage,
          props: { sample, mineId: mine.id, mineName: mine.name, choice, jevLaunch }
        }
      ]
    }
  }
}

/*
 * The settings row as its tree prints it, in the kit's frame: danger and stacked as its classes
 * say, its label and help the first texts, then each control in tree order — a switch named and
 * set as it prints, a key cap showing the next text, a button labelled with the next text in the
 * variant its classes carry. The warning banner is the banner alone, its line the one text.
 */
const settingsRow: Render = (_sample, texts, attributes) => {
  const style = attributes[0]?.attributes.style ?? ''
  if (elementsOf(attributes, 'div.dm-banner').length) {
    return {
      component: KitFrame,
      props: { style, parts: [{ component: SettingsBanner, props: { text: texts[0]?.text } }] }
    }
  }
  const root = attributes.find((entry) => entry.element.startsWith('div.dm-srow'))!
  const helped = elementsOf(attributes, 'p.dm-srow__help').length > 0
  let next = helped ? 2 : 1
  const controls: FramedPart[] = []
  for (const { element, attributes: a } of attributes) {
    if (element.startsWith('button.dm-toggle')) {
      controls.push({
        component: ToggleSwitch,
        props: { label: a['aria-label'] ?? '', on: a['aria-checked'] === 'true' }
      })
    } else if (element.startsWith('span.dm-kbd')) {
      controls.push({ component: KeyCap, props: {}, text: texts[next++]?.text })
    } else if (element.startsWith('button.dm-btn')) {
      controls.push({
        component: ActionButton,
        props: { label: texts[next++]?.text ?? '', variant: modifierOf(element, 'dm-btn') }
      })
    }
  }
  const row = {
    label: texts[0]?.text ?? '',
    ...(helped ? { help: texts[1]?.text } : {}),
    ...(root.element.includes('dm-srow--danger') ? { tone: 'danger' } : {}),
    stack: root.element.includes('dm-srow--stack')
  }
  return {
    component: KitFrame,
    props: { style, parts: [{ component: SettingsRow, props: row, children: controls }] }
  }
}

/*
 * The Settings page as its tree prints it, in the frame its root prints: the section its selected
 * tab names, the shortcut failed where the General tab carries the warning dot, Custom in force
 * where the tree draws the role selects, and each switch and volume as it prints. The rest is the
 * sample's: its edge, version and providers, the default shortcut on the platform the references
 * were taken on, the key configured with the Balanced profile and Claude as the default launch.
 */
const settings: Render = (sample, _texts, attributes) => {
  const selected = elementsOf(attributes, 'button.dm-settings__tab').find(
    (a) => a['aria-selected'] === 'true'
  )
  const failed = elementsOf(attributes, 'span.dm-warn-dot').length > 0
  const custom = selectsOf(attributes).some((s) => s.label === 'Titles font')
  const switchOn = (label: string, fallback: boolean): boolean => {
    const found = elementsOf(attributes, 'button.dm-toggle').find((a) => a['aria-label'] === label)
    return found === undefined ? fallback : found['aria-checked'] === 'true'
  }
  const volume = (label: string, fallback: number): number => {
    const found = elementsOf(attributes, 'input').find((a) => a['aria-label'] === label)
    return found === undefined ? fallback : Number(found.value) / 100
  }
  return {
    component: KitFrame,
    props: {
      style: attributes[0]?.attributes.style ?? '',
      parts: [
        {
          component: SettingsPanel,
          props: {
            section: selected?.['data-s'],
            shortcutState: {
              accelerator: DEFAULT_TOGGLE_ACCELERATOR,
              registered: !failed,
              platform: 'win32'
            },
            shortcutError: null,
            shortcutRecording: false,
            shortcutApplying: false,
            edge: sample.edge,
            edgeApplying: false,
            pinned: switchOn('Always on top', true),
            pinTooltip: '',
            versionText: sample.version ?? null,
            versionHint: '',
            resetting: false,
            resetError: null,
            audioSettings: {
              musicAtStartup: switchOn('Play music at startup', true),
              musicVolume: volume('Music volume', 0.1),
              ambienceVolume: volume('Mine ambience volume', 0.35),
              voiceVolume: volume('Dwarf voice and interface sound volume', 0.7),
              notificationSounds: switchOn('Play notification sounds', true)
            },
            notificationsEnabled: switchOn('Show system notifications', true),
            typography: custom
              ? { style: 'custom', faces: { ...DEFAULT_TYPOGRAPHY_PREFERENCES.faces } }
              : DEFAULT_TYPOGRAPHY_PREFERENCES,
            typographyApplying: false,
            jevSettings: {
              configured: true,
              preferences: {
                profile: 'balanced',
                default: { provider: 'claude' },
                delegation: switchOn('Let Jev choose subagents by subtask complexity', false)
              }
            },
            jevSaving: false,
            jevProviders: sample.providers,
            jevCatalogs: sample.catalogs,
            openCodeSettings: {
              pluginEnabled: switchOn('Answer OpenCode permission requests from the panel', true),
              passwordConfigured: false
            },
            openCodeApplying: false
          }
        }
      ]
    }
  }
}

export const RENDERS: Record<string, Render> = {
  // The Panel's nav in each of its states, every prop read off the state's own tree.
  'organisms/nav#default': nav,
  'organisms/nav#guild-revealed': nav,
  'organisms/nav#shortcut-failed': nav,
  'organisms/nav#in-valle': nav,
  // The guild pages, each in the kit's frame.
  'organisms/guild-page#lab': guildPage('lab'),
  'organisms/guild-page#market': guildPage('market'),
  'organisms/guild-page#laboral-union': guildPage('laboral-union'),
  // The Mines page (#635, PR2): not rebuilt yet, so each state draws the unbuilt specimen and
  // fails as it should until its component lands.
  // The page header plate: the Mines page's tools, and a title alone.
  'organisms/page-header#mines': pageHeader,
  'organisms/page-header#title-only': pageHeader,
  // The Mines page with the valley's mines, and on a first run.
  'organisms/mines-list#live': minesList,
  'organisms/mines-list#empty-first-run': minesList,
  // The mine card in each of its states, every prop read off the state's own tree.
  'molecules/mine-card#needs-you': mineCard,
  'molecules/mine-card#default': mineCard,
  'molecules/mine-card#hover': mineCard,
  'molecules/mine-card#pressed': mineCard,
  'molecules/mine-card#open': mineCard,
  'molecules/mine-card#open-and-needs-you': mineCard,
  'molecules/mine-card#measuring': mineCard,
  'molecules/mine-card#measuring-never-measured': mineCard,
  'molecules/mine-card#working-not-recorded-yet': mineCard,
  'molecules/mine-card#not-enterable': mineCard,
  'molecules/mine-card#max-tier': mineCard,
  // The tier and ore explainer, and the button that opens it.
  'organisms/tier-info#content': tierInfo,
  'organisms/tier-info#live': smallIconButton('info'),
  // The overlays: the menu's rows as its tree prints them; the dialog card in place, its title
  // its name and its actions the tree's buttons; the toast's plate. Each Live state is the trigger.
  'molecules/menu#messagepanel': menu(['console', 'history']),
  'molecules/menu#mine-card': menu([]),
  'molecules/menu#item-hovered': menu([]),
  'molecules/menu#danger-hovered': menu(['console']),
  'molecules/menu#live': () => ({ component: MenuButton, props: { items: [], title: 'More' } }),
  'molecules/dialog#confirm-danger': dialog,
  'molecules/dialog#typed-confirmation': dialog,
  'molecules/dialog#live': button({ labelled: true, variant: 'danger' }),
  'molecules/toast#static': toast('console'),
  'molecules/toast#live': button({ labelled: true }),
  'molecules/toast#shown': toast('info'),
  // The Map page with the valley's mines, and on a first run; the mine tooltip card, and its
  // Live state, which is its trigger button.
  'organisms/map-page#live': mapPage,
  'organisms/map-page#empty-first-run': mapPage,
  'molecules/tooltip#mine-tooltip': mineTooltip,
  'molecules/tooltip#live': button({ labelled: true }),
  // The mine column (#635, PR4): the column on the sample's mine, the roster, the dwarf on the
  // kit's scene and its tooltip card, and the mine history, each read off its own tree. The vault
  // strip, built with the Map page, draws the real
  // strip: a mine's footer, the map's totals plate, and a vault with no ore.
  'organisms/mine-column#dwarfai-miners': mineColumn,
  'organisms/mine-column#ai-tools': mineColumn,
  'molecules/crew-roster#four-dwarfs-one-selected': crewRoster([
    'worker',
    'worker2',
    'foreman',
    'worker'
  ]),
  'molecules/crew-roster#overflow': crewRoster(['worker', 'worker2', 'foreman', 'worker']),
  'molecules/crew-roster#empty': crewRoster([]),
  'molecules/dwarf#working-selected-hover': dwarfScene('silver'),
  'molecules/dwarf#asking-asleep-idle': dwarfScene('silver'),
  'molecules/dwarf#delivery-marks': dwarfScene('silver'),
  'molecules/dwarf-tooltip#working': dwarfTooltip('worker'),
  'molecules/dwarf-tooltip#needs-you': dwarfTooltip('worker2'),
  'molecules/dwarf-tooltip#asleep': dwarfTooltip('foreman'),
  'organisms/history-panel#dwarfai-miners': historyPanel,
  // The MessagePanel and the Add panel (#635, their slice), each read off its own tree.
  'organisms/message-panel#conversation': messagePanel,
  'organisms/message-panel#asking': messagePanel,
  'organisms/message-panel#not-delivered-with-actions': messagePanel,
  'organisms/message-panel#not-delivered-copy-alone': messagePanel,
  'organisms/message-panel#answer-refused': messagePanel,
  // The question card and its option (#635, PR3a): a question walked by steps, and a permission.
  'organisms/question-card#live': questionCard,
  'organisms/question-card#last-step': questionCard,
  'organisms/question-card#permission': questionCard,
  'organisms/question-card#long-request': questionCard,
  'molecules/question-option#default-hover-selected-pressed-focus': questionOptions,
  'molecules/question-option#other-thing': questionOptions,
  // A failed message's Retry and Copy (#635, decision log, Failed delivery), and its Copy alone on
  // a session that can no longer take text (decision log, Copy alone on a closed session).
  'molecules/chat-bubble#not-delivered-with-actions': userBubbles,
  'molecules/chat-bubble#not-delivered-copy-alone': userBubbles,
  'molecules/chat-bubble#retry-feedback': userBubbles,
  // The conversation's parts (#635, PR3b): a dwarf's rich text and your messages in each mark;
  // one run of steps closed, hovered, open, and still being added to; the composer empty and with
  // its well disabled.
  'molecules/chat-bubble#dwarf-rich-text': dwarfBubble,
  'molecules/chat-bubble#your-messages': userBubbles,
  'molecules/activity#closed': activityRun,
  'molecules/activity#hover': activityRun,
  'molecules/activity#open': activityRun,
  'molecules/activity#working': activityRun,
  'molecules/composer#empty': composer,
  'molecules/composer#disabled': composer,
  'organisms/add-panel#live': addPanel,
  'organisms/add-panel#supplier-picked': addPanel,
  'organisms/add-panel#custom-command': addPanel,
  'organisms/add-panel#jev-suggests-launch-in-flight': addPanel,
  'molecules/vault-strip#mine-footer': vaultStrip,
  'molecules/vault-strip#map-totals': vaultStrip,
  'molecules/vault-strip#empty': vaultStrip,
  // The Settings page (#635, PR5) on each of its sections, read off its own tree.
  'organisms/settings#general': settings,
  'organisms/settings#general-shortcut-failed': settings,
  'organisms/settings#sound': settings,
  'organisms/settings#notifications': settings,
  'organisms/settings#appearance': settings,
  'organisms/settings#appearance-custom': settings,
  'organisms/settings#integrations': settings,
  'organisms/settings#data': settings,
  'organisms/settings#about': settings,
  // The settings row: a switch row, the shortcut's key cap and Reset, the warning banner, and the
  // danger zone, each read off its own tree.
  'molecules/settings-row#toggle-row': settingsRow,
  'molecules/settings-row#shortcut-row': settingsRow,
  'molecules/settings-row#warning-banner': settingsRow,
  'molecules/settings-row#danger-zone': settingsRow,
  // The Panel screen's kit cell: the two buttons that open the screen and the prototype, each
  // labelled with the next text, the primary first, in the frame its tree prints.
  'screens/panel#open-the-screen': framed((texts) => [
    { component: ActionButton, props: { label: texts[0]?.text ?? '', variant: 'primary' } },
    { component: ActionButton, props: { label: texts[1]?.text ?? '' } }
  ]),

  'foundations/colour#materials': swatches([
    ...ramp('rock'),
    ...ramp('wood'),
    ...ramp('control'),
    ...ramp('gold'),
    ...ramp('brass'),
    'parch-hi',
    'parchment',
    'parch-lo',
    ...ramp('steel')
  ]),
  'foundations/colour#text': swatches([
    'ink',
    'ink-soft',
    'ink-faint',
    'ink-on-light',
    'ink-on-light-soft'
  ]),
  'foundations/colour#semantic': swatches(
    ['ok', 'warn', 'danger', 'info'].flatMap((name) => [name, name + '-lo'])
  ),
  // Canonical tier order: Bronze, Copper, Silver, Gold, Uranium.
  'foundations/colour#tiers': swatches(
    ['bronze', 'copper', 'silver', 'gold', 'uranium'].flatMap((tier) => [
      'tier-' + tier,
      'tier-' + tier + '-lo'
    ])
  ),
  'foundations/materials#surfaces': plates([
    'm-wood',
    'm-control',
    'm-rock',
    'm-well',
    'm-parchment',
    'm-parchment-well',
    'm-brass',
    'm-gold'
  ]),
  'foundations/materials#trims': plates(['m-wood', 'm-wood m-trim', 'm-wood m-trim-lit']),
  'foundations/materials#raised': plates(['m-wood m-raised', 'm-wood m-rivets']),
  'foundations/materials#focus-visible': plates(['m-wood is-focus']),
  'foundations/materials#rules': (_sample, texts) => ({ component: RuleFrame, props: { texts } }),
  'foundations/motion#tokens': () => ({
    component: TokenList,
    props: {
      names: [
        'dur-press',
        'dur-fast',
        'dur-base',
        'dur-panel',
        'dur-tip-delay',
        'dur-pulse',
        'frame-ms',
        'ease-step',
        'ease-out',
        'ease-in'
      ]
    }
  }),
  // One paragraph per role, in the anatomy's order, with the kit's inline colour on the two
  // display lines.
  'foundations/type#scale': (_sample, texts) => ({
    component: TypeScale,
    props: {
      lines: [
        { classes: 't-headline', color: 'gold' },
        { classes: 't-title', color: 'parchment' },
        { classes: 't-section' },
        { classes: 't-meta' },
        { classes: 't-label t-faint' },
        { classes: 't-talk' },
        { classes: 't-code t-soft' }
      ],
      texts
    }
  }),
  // The two motion states draw the redesigned button (design lead ruling, tokens-port question
  // 5): Enter beside the overlay plate it replays, Press as the primary button alone.
  'foundations/motion#enter': (_sample, texts) => ({ component: EnterFrame, props: { texts } }),
  'foundations/motion#press': button({ labelled: true, variant: 'primary' }),
  // Specimens with no view yet. The presets draw the page header, the mine card and two bubbles
  // in each preset: all three are components now (ChatBubble since #635's MessagePanel slice),
  // and the specimen that sets them side by side is not built yet.
  'foundations/type-presets#dwarfai-pixel-clean-readable': unbuilt,

  // The icon registry at both scales, and the tones on the close and check icons.
  'atoms/icon#registry-at-2x': (_sample, texts) => ({
    component: IconSheet,
    props: { scale: 2, texts }
  }),
  'atoms/icon#registry-at-1x': (_sample, texts) => ({
    component: IconSheet,
    props: { scale: 1, texts }
  }),
  'atoms/icon#tones': () => ({
    component: IconRow,
    props: {
      icons: [{ name: 'close', tone: 'danger' }, { name: 'close', tone: 'dim' }, { name: 'check' }]
    }
  }),

  // The button's states, each in the kit's row frame; `state` forces the look a pointer or the
  // keyboard would give, as the kit's own option does.
  'atoms/button#secondary': buttonRow(STATES.map((state) => ({ labelled: true, state }))),
  'atoms/button#primary': buttonRow(
    STATES.map((state) => ({ labelled: true, variant: 'primary', icon: 'send', state }))
  ),
  'atoms/button#danger': buttonRow(
    STATES.slice(0, 3).map((state) => ({ labelled: true, variant: 'danger', state }))
  ),
  'atoms/button#disabled': buttonRow([
    { labelled: true, variant: 'primary', disabled: true },
    { labelled: true, disabled: true },
    { icon: 'attach', title: 'attach', disabled: true }
  ]),
  'atoms/button#toggle': buttonRow([
    { icon: 'ambience-on', title: 'ambience-on', pressed: false },
    { icon: 'ambience-on', title: 'ambience-on', pressed: true },
    { labelled: true, pressed: true }
  ]),
  'atoms/button#icon-only': buttonRow([
    { icon: 'history', title: 'history' },
    { icon: 'close', title: 'close' },
    { icon: 'more', title: 'more', state: 'hover' },
    { icon: 'more', title: 'more', size: 'sm' },
    { icon: 'info', title: 'info', size: 'sm' }
  ]),
  'atoms/button#large-primary': button({ labelled: true, variant: 'primary', size: 'lg' }),
  'atoms/button#link': buttonRow(
    STATES.slice(0, 2).map((state) => ({ labelled: true, variant: 'link', state }))
  ),

  // The input's states, each in the kit's frame; `state` forces the look a pointer or the
  // keyboard would give, as the kit's own option does.
  'atoms/input#text': fields([{}]),
  'atoms/input#hover': fields([{ state: 'hover' }]),
  'atoms/input#focus': fields([{ state: 'focus' }]),
  'atoms/input#search': fields([{ search: true }, { search: true }]),
  'atoms/input#invalid': fields([{ invalid: true }], { hint: true }),
  'atoms/input#disabled': fields([{}]),
  'atoms/input#textarea': fields([{ area: true }], { control: 'textarea' }),

  // The select at rest, forced to hover and to focus, in the kit's row; disabled alone.
  'atoms/select#default-hover-focus': framed((_texts, attributes) =>
    selectsOf(attributes).map((props, i) => ({
      component: SelectField,
      props: { ...props, state: [undefined, 'hover', 'focus'][i] }
    }))
  ),
  'atoms/select#disabled': (_sample, _texts, attributes) => ({
    component: SelectField,
    props: selectsOf(attributes)[0]!
  }),
  // The toggle's states in the kit's row: hover, pressed while on, and focus are forced looks.
  'atoms/toggle#off-on': toggles(),
  'atoms/toggle#hover-pressed-focus': toggles(['hover', 'active', 'focus']),
  'atoms/toggle#disabled': toggles(),

  // The slider's states, each in the kit's frame; hover is a forced look.
  'atoms/slider#default': sliders(),
  'atoms/slider#hover': sliders(['hover']),
  'atoms/slider#muted-full': sliders(),
  'atoms/slider#disabled': sliders(),
  // The chips in the kit's row: a choice chip at rest, forced to hover and to press, pressed,
  // disabled and forced to focus; the tier filters in canonical order; the tier chips, whose word
  // is the chip's own; and the meta chips, each fact the next text.
  'atoms/chip#choice-chip': choiceChips([
    undefined,
    'hover',
    'active',
    undefined,
    undefined,
    'focus'
  ]),
  'atoms/chip#tier-filter-chips': choiceChips(),
  'atoms/chip#tier-chips': framed((_texts, attributes) =>
    elementsOf(attributes, 'span.dm-tier').map((chip) => ({
      component: TierChip,
      props: { tier: chip['data-tier'] as MineTier }
    }))
  ),
  'atoms/chip#meta-chips': framed((texts) =>
    texts.map((fact) => ({ component: MetaChip, props: { text: fact.text ?? '' } }))
  ),

  // The nav slots in the kit's row: at rest, hovered and pressed; current; badged; the music
  // toggle; warned; focused; the mode lever.
  'atoms/slot#default-hover-pressed': slots(['map', 'map', 'map']),
  'atoms/slot#current-page': slots(['mines']),
  'atoms/slot#needs-you-badge': slots(['mines', 'mines']),
  'atoms/slot#toggle': slots(['music-off', 'music-on']),
  'atoms/slot#warning': slots(['settings']),
  'atoms/slot#focus-visible': slots(['settings']),
  'atoms/slot#mode-lever': slots(['valle', 'veta']),

  // The portraits: the three ranks, the five statuses, the interaction looks, the three sizes.
  'atoms/portrait#ranks': portraits(['worker', 'worker2', 'foreman']),
  'atoms/portrait#status': portraits(['worker', 'worker2', 'foreman', 'worker', 'worker2']),
  'atoms/portrait#interaction': portraits(['worker', 'worker', 'worker', 'worker']),
  'atoms/portrait#sizes': portraits(['foreman', 'foreman', 'foreman']),

  // The tier progress toward Gold and toward Copper, measuring, and at the top tier.
  'atoms/progress#toward-gold': progress,
  'atoms/progress#toward-copper': progress,
  'atoms/progress#measuring': progress,
  'atoms/progress#max-tier': progress,

  // The ore capsules: every material, poorest first; the vault size; a material at zero.
  'atoms/ore#every-material': oreRow,
  'atoms/ore#large': oreAlone,
  'atoms/ore#zero': oreAlone,

  // The map markers on their points: every tier; hovered, pressed and open; asking; focused.
  // The badges in their tones and overflow, and the pills: the crew states, then the semantic tones.
  'atoms/badge#badges': badges,
  'atoms/badge#crew-state-pills': pills(),
  'atoms/badge#semantic-pills': pills(['check']),
  'atoms/marker#tiers': markers,
  'atoms/marker#hover-pressed-open': markers,
  'atoms/marker#needs-you': markers,
  'atoms/marker#focus-visible': markers,

  // The sprite atom's sheets at 1x, 2x and 2x mirrored in the kit's row, and the still option alone.
  'atoms/sprite#worker-working': sprites,
  'atoms/sprite#worker-idle': sprites,
  'atoms/sprite#worker-start-working': sprites,
  'atoms/sprite#worker2-working': sprites,
  'atoms/sprite#worker2-start-working': sprites,
  'atoms/sprite#worker2-idle': sprites,
  'atoms/sprite#foreman-idle': sprites,
  'atoms/sprite#foreman-sleeping': sprites,
  'atoms/sprite#base-idle': sprites,
  'atoms/sprite#still': spriteAlone
}
