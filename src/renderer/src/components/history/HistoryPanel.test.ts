// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import {
  HISTORY_EMPTY_NOTE,
  HISTORY_READING_NOTE,
  HISTORY_READ_ONLY_NOTE,
  HISTORY_SCOPE_NOTE,
  HISTORY_TRUNCATED_NOTE,
  HISTORY_UNREADABLE_NOTE
} from '../../lib/history/mineHistory'
import { defaultDwarf, defaultMine } from '../../testing/factories'
import { MINE_HISTORY_MESSAGE_LIMIT, type MineHistorySpeaker } from '../../types'
import HistoryPanel from './HistoryPanel.vue'

/*
 * The mine history (#635), `organisms/history-panel` in the design, which replaces
 * MineHistoryPanel. Read-only; a tab per dwarf, a tablist named "Dwarfs" with ←/→ between tabs,
 * the panel named "Mine history, <mine>". Where each of MineHistoryPanel.test.ts's guarantees
 * went, stated as test-safety asks:
 *
 * - tabs: "one tab per dwarf that has spoken, newest first" is AMENDED to the crew's roster order
 *   first, former dwarfs newest first (lib/history/mineHistory.test.ts, historyTabs); "opens on the
 *   newest tab" is now the first tab; tab click, the chosen tab surviving a reorder, and the
 *   fallback when it is gone: here.
 * - transcript: the 50-message cap, user and agent rows on their own surfaces, a prompt another
 *   agent issued drawn as that agent's (a Dwarf bubble, not You), read-only: here. "draws the
 *   speaker's own rank on its own words" is RETIRED with the bubble portraits the design dropped;
 *   each tab still wears the rank's face.
 * - activity lines (#240), path-opening lines (#279), the disclosure (#294): here, in the design's
 *   activity molecule; the run's label is the design's "N steps · activity".
 * - timestamp ("the design's format, lower right", "follows the tab"): REPLACED, the design prints
 *   no footer; each tab says "last · HH:MM" and each bubble its time (here).
 * - nothing to show (three notes), the reached-start notice (#227, four cases), closing (control,
 *   Escape, the mine's name): here.
 * - list motion (#566 T4b, six cases on AnimatePresence and fadeVariants): REPLACED by the design's
 *   own arrival, `.dm-bubble.is-new` (dm-pop-in); what they pinned — nothing animates on mount or
 *   on a tab switch or past the cap, an arrival in the same tab does — is pinned here.
 */

const NEWEST: MineHistorySpeaker = {
  id: 'claude:s2',
  provider: 'claude',
  role: 'worker',
  name: 'Map the seam',
  lastMessageAt: new Date(2026, 8, 4, 9, 5).getTime(),
  messages: [
    {
      role: 'user',
      text: 'Map the seam.',
      timestamp: new Date(2026, 8, 4, 9, 4).toISOString(),
      issuer: { role: 'foreman', name: 'Foreman' }
    },
    {
      role: 'assistant',
      text: 'Mapped **it**.',
      timestamp: new Date(2026, 8, 4, 9, 5).toISOString()
    }
  ]
}

const OLDER: MineHistorySpeaker = {
  id: 'claude:s1',
  provider: 'claude',
  role: 'foreman',
  name: 'Foreman',
  lastMessageAt: new Date(2026, 8, 3, 18, 30).getTime(),
  messages: [
    { role: 'user', text: 'dig here', timestamp: new Date(2026, 8, 3, 18, 29).toISOString() },
    {
      role: 'assistant',
      text: 'Found the seam.',
      timestamp: new Date(2026, 8, 3, 18, 30).toISOString()
    }
  ]
}

function panel(props: Record<string, unknown> = {}) {
  return mount(HistoryPanel, {
    props: {
      mine: defaultMine({ name: 'anvil' }),
      history: { readable: true, speakers: [OLDER, NEWEST] },
      ...props
    },
    attachTo: document.body
  })
}

const tabs = (wrapper: ReturnType<typeof panel>) => wrapper.findAll('.dm-hist__tab')
const names = (wrapper: ReturnType<typeof panel>) =>
  tabs(wrapper).map((tab) => tab.find('.dm-hist__name').text())

describe('HistoryPanel', () => {
  it('is a dialog named "Mine history, <mine>", titled "History · <mine>"', () => {
    const wrapper = panel()
    const section = wrapper.find('section.dm-hist')
    expect(section.attributes('role')).toBe('dialog')
    expect(section.attributes('aria-label')).toBe('Mine history, anvil')
    expect(wrapper.find('.dm-hist__title').text()).toBe('History · anvil')
  })

  it('closes from its own control and on Escape', async () => {
    const wrapper = panel()
    await wrapper.find('button[aria-label="Close history"]').trigger('click')
    await wrapper.find('section').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(2)
  })
})

describe('HistoryPanel tabs', () => {
  it('draws a tablist named "Dwarfs", a tab per dwarf, newest first while none is in the crew', () => {
    const wrapper = panel()
    expect(wrapper.find('.dm-hist__tabs').attributes('role')).toBe('tablist')
    expect(wrapper.find('.dm-hist__tabs').attributes('aria-label')).toBe('Dwarfs')
    expect(names(wrapper)).toEqual(['Map the seam', 'Foreman'])
  })

  it('puts the crew first, in the roster’s order', () => {
    const wrapper = panel({
      mine: defaultMine({
        name: 'anvil',
        dwarfs: [defaultDwarf({ id: 'claude:s1', role: 'foreman' })]
      })
    })
    expect(names(wrapper)).toEqual(['Foreman', 'Map the seam'])
  })

  it('gives each tab the rank’s face, its state, and "last · HH:MM"', () => {
    const wrapper = panel({
      mine: defaultMine({
        dwarfs: [defaultDwarf({ id: 'claude:s1', role: 'foreman', status: 'waiting' })]
      })
    })
    const [first, second] = tabs(wrapper)
    expect(first!.find('.dm-portrait.dm-portrait--sm').attributes('data-status')).toBe('asleep')
    expect(first!.find('small').text()).toBe('last · 18:30')
    // A dwarf no longer in the mine is neither working nor asleep.
    expect(second!.find('.dm-portrait').attributes('data-status')).toBe('idle')
    expect(second!.find('small').text()).toBe('last · 09:05')
  })

  it('opens on the first tab, and shows that dwarf alone', () => {
    const wrapper = panel()
    const [first, second] = tabs(wrapper)
    expect(first!.attributes('aria-selected')).toBe('true')
    expect(first!.attributes('tabindex')).toBe('0')
    expect(second!.attributes('aria-selected')).toBe('false')
    expect(second!.attributes('tabindex')).toBe('-1')
    expect(wrapper.find('.dm-hist__log').text()).toContain('Mapped')
    expect(wrapper.find('.dm-hist__log').text()).not.toContain('Found the seam.')
  })

  it("replaces the transcript with the chosen dwarf's on a tab press", async () => {
    const wrapper = panel()
    await tabs(wrapper)[1]!.trigger('click')
    expect(wrapper.find('.dm-hist__log').text()).toContain('Found the seam.')
    expect(tabs(wrapper)[1]!.attributes('aria-selected')).toBe('true')
  })

  it('moves between tabs with ← and →, as a tablist should, wrapping at the ends', async () => {
    const wrapper = panel()
    await tabs(wrapper)[0]!.trigger('keydown', { key: 'ArrowRight' })
    expect(tabs(wrapper)[1]!.attributes('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tabs(wrapper)[1]!.element)
    await tabs(wrapper)[1]!.trigger('keydown', { key: 'ArrowRight' })
    expect(tabs(wrapper)[0]!.attributes('aria-selected')).toBe('true')
    await tabs(wrapper)[0]!.trigger('keydown', { key: 'ArrowLeft' })
    expect(tabs(wrapper)[1]!.attributes('aria-selected')).toBe('true')
  })

  it('keeps the chosen tab open when a live re-read reorders the dwarfs', async () => {
    const wrapper = panel()
    await tabs(wrapper)[1]!.trigger('click')
    await wrapper.setProps({
      history: {
        readable: true,
        speakers: [{ ...OLDER, lastMessageAt: NEWEST.lastMessageAt + 1 }, NEWEST]
      }
    })
    expect(names(wrapper)).toEqual(['Foreman', 'Map the seam'])
    expect(tabs(wrapper)[0]!.attributes('aria-selected')).toBe('true')
  })

  it('falls back to the first tab when the chosen dwarf is no longer in the history', async () => {
    const wrapper = panel()
    await tabs(wrapper)[1]!.trigger('click')
    await wrapper.setProps({ history: { readable: true, speakers: [NEWEST] } })
    expect(tabs(wrapper)[0]!.attributes('aria-selected')).toBe('true')
  })
})

describe('HistoryPanel transcript', () => {
  it('says it is read-only, up to the latest fifty, and shows no more than that', () => {
    const many: MineHistorySpeaker = {
      ...NEWEST,
      messages: Array.from({ length: MINE_HISTORY_MESSAGE_LIMIT + 5 }, (_, i) => ({
        role: 'assistant' as const,
        text: 'reply ' + i,
        timestamp: ''
      }))
    }
    const wrapper = panel({ history: { readable: true, speakers: [many] } })
    expect(wrapper.find('.dm-hist__note').text()).toBe(HISTORY_READ_ONLY_NOTE)
    // #192's caveat, that the CLIs prune their own transcripts, on the note that states the cap.
    expect(wrapper.find('.dm-hist__note').attributes('title')).toBe(HISTORY_SCOPE_NOTE)
    expect(wrapper.findAll('.dm-bubble')).toHaveLength(MINE_HISTORY_MESSAGE_LIMIT)
  })

  it('draws the person’s words as a You bubble and the dwarf’s as a Dwarf bubble, each with its time', async () => {
    const wrapper = panel()
    await tabs(wrapper)[1]!.trigger('click')
    const [you, dwarf] = wrapper.findAll('.dm-bubble')
    expect(you!.classes()).toContain('dm-bubble--user')
    expect(you!.attributes('aria-label')).toBe('You')
    expect(you!.find('.dm-bubble__foot').text()).toContain('18:29')
    expect(dwarf!.classes()).not.toContain('dm-bubble--user')
    expect(dwarf!.attributes('aria-label')).toBe('Dwarf')
  })

  it('draws a prompt another agent issued as that agent’s words, never as the person’s (#175)', () => {
    const wrapper = panel()
    const first = wrapper.findAll('.dm-bubble')[0]!
    expect(first.attributes('aria-label')).toBe('Dwarf')
    expect(first.classes()).not.toContain('dm-bubble--user')
  })

  it('renders the words as Markdown', () => {
    const wrapper = panel()
    expect(wrapper.find('.dm-bubble strong').text()).toBe('it')
  })

  /*
   * A prompt in the transcript was handed to the session (✓); it is ✓✓ only when the session was
   * seen acting after it (historyMarks). The marks are text with a name, never colour alone.
   */
  it('marks the person’s prompts ✓ handed over or ✓✓ seen acting, as the record shows', async () => {
    const wrapper = panel({
      history: {
        readable: true,
        speakers: [
          {
            ...OLDER,
            messages: [...OLDER.messages, { role: 'user', text: 'and more', timestamp: '' }]
          }
        ]
      }
    })
    const marks = wrapper.findAll('.dm-bubble__mark')
    expect(marks.map((m) => [m.text(), m.attributes('data-mark'), m.attributes('title')])).toEqual([
      ['✓✓', 'reacted', 'Seen acting on it'],
      ['✓', 'delivered', 'Handed over to the queue']
    ])
  })

  it('is read-only: no composer, no field, nothing to send with', () => {
    const wrapper = panel()
    expect(wrapper.find('textarea').exists()).toBe(false)
    expect(wrapper.find('input').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Send')
  })
})

describe('HistoryPanel activity (#240, #279, #294)', () => {
  const WITH_RUN: MineHistorySpeaker = {
    ...NEWEST,
    messages: [
      ...NEWEST.messages,
      {
        role: 'assistant',
        text: 'Read src/shared/contracts.ts',
        timestamp: '',
        activity: { kind: 'read', target: 'src/shared/contracts.ts' }
      },
      {
        role: 'assistant',
        text: 'Ran pnpm test',
        timestamp: '',
        activity: { kind: 'run', target: 'pnpm test' }
      }
    ]
  }
  const withRun = (props: Record<string, unknown> = {}) =>
    panel({ history: { readable: true, speakers: [OLDER, WITH_RUN] }, ...props })

  it('folds a run of tool calls into one closed disclosure, "N steps · activity", never Working...', () => {
    const wrapper = withRun()
    const toggle = wrapper.find('.dm-activity__toggle')
    expect(toggle.text()).toBe('2 steps · activity')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('.dm-activity__list').attributes('hidden')).toBeDefined()
    // A tool call is one row of its own, never a bubble.
    expect(wrapper.findAll('.dm-bubble')).toHaveLength(2)
  })

  it('opens in place to the run’s own steps, in order, and folds again on a second press', async () => {
    const wrapper = withRun()
    await wrapper.find('.dm-activity__toggle').trigger('click')
    expect(wrapper.find('.dm-activity__toggle').attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('.dm-activity__list').attributes('hidden')).toBeUndefined()
    expect(wrapper.findAll('.dm-activity__list li').map((li) => li.text())).toEqual([
      'Read src/shared/contracts.ts',
      'Ran pnpm test'
    ])
    await wrapper.find('.dm-activity__toggle').trigger('click')
    expect(wrapper.find('.dm-activity__list').attributes('hidden')).toBeDefined()
  })

  it('draws a read or edit step as a button styled as text that opens its own path', async () => {
    const wrapper = withRun()
    await wrapper.find('.dm-activity__toggle').trigger('click')
    const [read, run] = wrapper.findAll('.dm-activity__list li')
    const button = read!.find('button.dm-activity__path')
    expect(button.attributes('type')).toBe('button')
    // A run is plain text: there is nothing to open.
    expect(run!.find('button').exists()).toBe(false)
    await button.trigger('click')
    const [payload] = wrapper.emitted('open-path')?.[0] as [{ key: string; target: string }]
    expect(payload.target).toBe('src/shared/contracts.ts')
    expect(payload.key).toBe(button.attributes('data-row-key'))
  })

  it("shows main's refusal as that row's own title, and on no other row", async () => {
    const first = withRun()
    await first.find('.dm-activity__toggle').trigger('click')
    const key = first.find('button.dm-activity__path').attributes('data-row-key')
    const refused = withRun({ pathRefusal: { key, reason: 'That file no longer exists.' } })
    await refused.find('.dm-activity__toggle').trigger('click')
    expect(refused.find('button.dm-activity__path').attributes('title')).toBe(
      'That file no longer exists.'
    )
    const other = withRun({ pathRefusal: { key: 'not-this-row', reason: 'Gone.' } })
    await other.find('.dm-activity__toggle').trigger('click')
    expect(other.find('button.dm-activity__path').attributes('title')).toBe(
      'Read src/shared/contracts.ts'
    )
  })
})

describe('HistoryPanel with nothing to show', () => {
  it('says "Nobody has worked here yet." and draws no tab', () => {
    const wrapper = panel({ history: { readable: true, speakers: [] } })
    expect(wrapper.text()).toContain(HISTORY_EMPTY_NOTE)
    expect(tabs(wrapper)).toHaveLength(0)
  })

  it('says it is still reading while nothing has come back', () => {
    expect(panel({ history: undefined }).text()).toContain(HISTORY_READING_NOTE)
  })

  it('says the mine could not be read rather than that nobody worked here', () => {
    const wrapper = panel({ history: { readable: false, speakers: [] } })
    expect(wrapper.text()).toContain(HISTORY_UNREADABLE_NOTE)
    expect(wrapper.text()).not.toContain(HISTORY_EMPTY_NOTE)
  })
})

describe('HistoryPanel reached-start notice (#227)', () => {
  it('admits a tab does not reach the start, only for the speaker the flag names', async () => {
    const wrapper = panel({
      history: { readable: true, speakers: [OLDER, { ...NEWEST, reachedStart: false }] }
    })
    expect(wrapper.text()).toContain(HISTORY_TRUNCATED_NOTE)
    await tabs(wrapper)[1]!.trigger('click')
    expect(wrapper.text()).not.toContain(HISTORY_TRUNCATED_NOTE)
  })

  it('says nothing when the read reached the start, or when the flag is absent', () => {
    expect(
      panel({ history: { readable: true, speakers: [{ ...NEWEST, reachedStart: true }] } }).text()
    ).not.toContain(HISTORY_TRUNCATED_NOTE)
    expect(panel().text()).not.toContain(HISTORY_TRUNCATED_NOTE)
  })
})

describe('HistoryPanel arrivals', () => {
  const newBubbles = (wrapper: ReturnType<typeof panel>) => wrapper.findAll('.dm-bubble.is-new')

  it('animates no bubble on an ordinary mount', () => {
    expect(newBubbles(panel())).toHaveLength(0)
  })

  it('animates a message that arrives in the tab being read', async () => {
    const wrapper = panel()
    await wrapper.setProps({
      history: {
        readable: true,
        speakers: [
          OLDER,
          {
            ...NEWEST,
            messages: [...NEWEST.messages, { role: 'assistant', text: 'And more.', timestamp: 'x' }]
          }
        ]
      }
    })
    expect(newBubbles(wrapper).map((b) => b.text())).toEqual([expect.stringContaining('And more.')])
  })

  it('does not animate a tab switch: fifty bubbles appearing at once stay a cut', async () => {
    const wrapper = panel()
    await tabs(wrapper)[1]!.trigger('click')
    expect(newBubbles(wrapper)).toHaveLength(0)
  })

  it('does not animate a speaker past the cap, whose window slides on every message', async () => {
    const full = Array.from({ length: MINE_HISTORY_MESSAGE_LIMIT }, (_, i) => ({
      role: 'assistant' as const,
      text: 'reply ' + i,
      timestamp: 't' + i
    }))
    const wrapper = panel({
      history: { readable: true, speakers: [{ ...NEWEST, messages: full }] }
    })
    await wrapper.setProps({
      history: {
        readable: true,
        speakers: [
          {
            ...NEWEST,
            messages: [...full, { role: 'assistant' as const, text: 'reply new', timestamp: 'tn' }]
          }
        ]
      }
    })
    expect(newBubbles(wrapper).map((b) => b.text())).toEqual([expect.stringContaining('reply new')])
  })
})

// PANEL-QUESTIONS 16: a message that never arrived is part of what happened in the mine.
describe('HistoryPanel failed sends', () => {
  it('draws a failed message "✕ not delivered", read-only, and counts it in the tab time', () => {
    const wrapper = panel({
      history: { readable: true, speakers: [OLDER] },
      failed: {
        'claude:s1': [{ text: 'never got there', sentAt: new Date(2026, 8, 3, 18, 40).getTime() }]
      }
    })
    const last = wrapper.findAll('.dm-bubble').at(-1)!
    expect(last.classes()).toContain('dm-bubble--user')
    expect(last.find('.dm-bubble__text').text()).toBe('never got there')
    const mark = last.find('.dm-bubble__mark')
    expect(mark.text()).toBe('✕ not delivered')
    expect(mark.attributes('data-mark')).toBe('failed')
    expect(mark.attributes('title')).toBe('Not delivered')
    // No Retry, no Copy: the history is read-only.
    expect(last.find('button').exists()).toBe(false)
    expect(wrapper.find('.dm-hist__tab small').text()).toBe('last · 18:40')
  })
})
