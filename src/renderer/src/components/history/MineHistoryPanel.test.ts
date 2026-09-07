// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { PORTRAIT_SRC, USER_PORTRAIT_SRC } from '../../lib/art'
import {
  HISTORY_EMPTY_NOTE,
  HISTORY_READING_NOTE,
  HISTORY_UNREADABLE_NOTE,
  formatHistoryTimestamp
} from '../../lib/history/mineHistory'
import { defaultMine } from '../../testing/factories'
import { MINE_HISTORY_MESSAGE_LIMIT, type MineHistorySpeaker } from '../../types'
import MineHistoryPanel from './MineHistoryPanel.vue'

/*
 * The design's Mine History panel (#192, `screens/history.md`): floating,
 * read-only, one tab per dwarf that has spoken, newest first, the latest fifty
 * messages of the selected one, and its last-message time at the lower right.
 * What is pinned here is the behaviour the design fixes plus the defaults
 * #192's maintainer comment settled for what it leaves Unspecified.
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
      timestamp: '2026-09-04T09:04:00Z',
      issuer: { role: 'foreman', name: 'Foreman' }
    },
    { role: 'assistant', text: 'Mapped it.', timestamp: '2026-09-04T09:05:00Z' }
  ]
}

const OLDER: MineHistorySpeaker = {
  id: 'claude:s1',
  provider: 'claude',
  role: 'foreman',
  name: 'Foreman',
  lastMessageAt: new Date(2026, 8, 3, 18, 30).getTime(),
  messages: [
    { role: 'user', text: 'dig here', timestamp: '2026-09-03T18:29:00Z' },
    { role: 'assistant', text: 'Found the seam.', timestamp: '2026-09-03T18:30:00Z' }
  ]
}

function panel(props: Record<string, unknown> = {}) {
  return mount(MineHistoryPanel, {
    props: {
      mine: defaultMine({ name: 'anvil' }),
      history: { readable: true, speakers: [OLDER, NEWEST] },
      ...props
    }
  })
}

describe('MineHistoryPanel tabs', () => {
  it('draws one tab per dwarf that has spoken, newest first', () => {
    const tabs = panel().findAll('.history-tab')
    expect(tabs.map((tab) => tab.text())).toEqual(['Map the seam', 'Foreman'])
  })

  it('opens on the newest tab, and shows that dwarf alone', () => {
    const wrapper = panel()
    const [first, second] = wrapper.findAll('.history-tab')
    expect(first?.classes()).toContain('is-selected')
    expect(first?.attributes('aria-selected')).toBe('true')
    expect(second?.attributes('aria-selected')).toBe('false')
    expect(wrapper.findAll('.bubble').map((bubble) => bubble.text())).toEqual([
      'Map the seam.',
      'Mapped it.'
    ])
  })

  it("replaces the transcript with the chosen dwarf's on a tab click", async () => {
    const wrapper = panel()
    await wrapper.findAll('.history-tab')[1]!.trigger('click')

    expect(wrapper.findAll('.history-tab')[1]?.classes()).toContain('is-selected')
    expect(wrapper.findAll('.bubble').map((bubble) => bubble.text())).toEqual([
      'dig here',
      'Found the seam.'
    ])
  })

  it('keeps the chosen tab open when a live re-read reorders the dwarfs', async () => {
    const wrapper = panel()
    await wrapper.findAll('.history-tab')[1]!.trigger('click')

    // The older dwarf speaks again and becomes the newest: it moves to the
    // first tab, and the person's selection follows it there.
    const spoke = { ...OLDER, lastMessageAt: NEWEST.lastMessageAt + 60_000 }
    await wrapper.setProps({ history: { readable: true, speakers: [NEWEST, spoke] } })

    const tabs = wrapper.findAll('.history-tab')
    expect(tabs.map((tab) => tab.text())).toEqual(['Foreman', 'Map the seam'])
    expect(tabs[0]?.classes()).toContain('is-selected')
  })

  it('falls back to the newest tab when the chosen dwarf is no longer in the history', async () => {
    const wrapper = panel()
    await wrapper.findAll('.history-tab')[1]!.trigger('click')
    await wrapper.setProps({ history: { readable: true, speakers: [NEWEST] } })
    expect(wrapper.find('.history-tab').classes()).toContain('is-selected')
    expect(wrapper.find('.bubble').text()).toBe('Map the seam.')
  })
})

describe('MineHistoryPanel transcript', () => {
  it('shows at most the latest MINE_HISTORY_MESSAGE_LIMIT messages of a tab', () => {
    const messages = Array.from({ length: MINE_HISTORY_MESSAGE_LIMIT + 5 }, (_, index) => ({
      role: 'assistant' as const,
      text: `reply ${index}`,
      timestamp: ''
    }))
    const wrapper = panel({ history: { readable: true, speakers: [{ ...NEWEST, messages }] } })
    const bubbles = wrapper.findAll('.bubble')
    expect(bubbles).toHaveLength(MINE_HISTORY_MESSAGE_LIMIT)
    expect(bubbles[0]?.text()).toBe('reply 5')
  })

  it("uses the message panel's own surfaces: agent rows start-aligned with a portrait, user rows end-aligned", () => {
    const wrapper = panel()
    const rows = wrapper.findAll('.message')
    expect(rows[0]?.classes()).toContain('is-agent')
    expect(rows[1]?.classes()).toContain('is-agent')
    // The human's row, on the older tab.
    return wrapper
      .findAll('.history-tab')[1]!
      .trigger('click')
      .then(() => {
        const [human, agent] = wrapper.findAll('.message')
        expect(human?.classes()).toContain('is-user')
        expect(human?.find('.portrait').attributes('src')).toBe(USER_PORTRAIT_SRC)
        expect(agent?.find('.portrait').attributes('src')).toBe(PORTRAIT_SRC.foreman)
      })
  })

  it('draws a prompt another agent issued under that agent, not the human (#175)', () => {
    const wrapper = panel()
    const issued = wrapper.findAll('.message')[0]!
    expect(issued.classes()).toContain('is-agent')
    expect(issued.find('.portrait').attributes('src')).toBe(PORTRAIT_SRC.foreman)
    expect(issued.find('.portrait').attributes('alt')).toBe('Foreman, foreman')
  })

  it("draws the speaker's own rank on its own words", () => {
    const wrapper = panel()
    const own = wrapper.findAll('.message')[1]!
    expect(own.find('.portrait').attributes('src')).toBe(PORTRAIT_SRC.worker)
  })

  it('is read-only: no composer, no input, nothing to send with', () => {
    const wrapper = panel()
    expect(wrapper.find('textarea').exists()).toBe(false)
    expect(wrapper.find('input').exists()).toBe(false)
    const controls = wrapper.findAll('button').filter((button) => !button.classes('history-tab'))
    expect(controls.map((button) => button.attributes('aria-label'))).toEqual(['Close history'])
  })
})

/**
 * One line per tool call, same rule as the interactive MessagePanel (#240):
 * `screens/mine.md` draws it in both surfaces from the same wire shape, so a
 * call reads the same whichever tab shows it.
 */
describe('MineHistoryPanel activity lines (#240)', () => {
  const WITH_ACTIVITY: MineHistorySpeaker = {
    ...NEWEST,
    messages: [
      ...NEWEST.messages,
      {
        role: 'assistant',
        text: 'Ran pnpm test',
        timestamp: '2026-09-04T09:06:00Z',
        activity: { kind: 'run', target: 'pnpm test' }
      }
    ]
  }

  it('draws a tool call as its own muted line rather than a bubble', () => {
    const wrapper = panel({ history: { readable: true, speakers: [OLDER, WITH_ACTIVITY] } })
    const line = wrapper.find('.activity-line')
    expect(line.exists()).toBe(true)
    expect(line.text()).toBe('Ran pnpm test')
    expect(line.attributes('title')).toBe('Ran pnpm test')
  })

  it('draws no portrait for a tool-call line', () => {
    const wrapper = panel({ history: { readable: true, speakers: [OLDER, WITH_ACTIVITY] } })
    expect(wrapper.find('.activity-line').find('.portrait').exists()).toBe(false)
  })

  it('counts the tool-call line as one row, alongside the ordinary bubbles', () => {
    const wrapper = panel({ history: { readable: true, speakers: [OLDER, WITH_ACTIVITY] } })
    expect(wrapper.findAll('.bubble')).toHaveLength(2)
    expect(wrapper.findAll('.activity-line')).toHaveLength(1)
  })

  it('draws a run line as a plain paragraph rather than a clickable control', () => {
    const wrapper = panel({ history: { readable: true, speakers: [OLDER, WITH_ACTIVITY] } })
    expect(wrapper.find('.activity-line').element.tagName).toBe('P')
  })
})

/**
 * Only an `edit`/`read` activity line's own path opens the file (#279); `run`
 * stays the plain paragraph pinned above. This panel is read-only and has no
 * IPC of its own (#192) — App.vue owns the open, exactly as it owns
 * `getMineHistory` — so what is pinned here is the emit's own payload and how
 * a refusal main handed back is shown on the row's title.
 */
describe('MineHistoryPanel path-opening lines (#279)', () => {
  const WITH_EDIT: MineHistorySpeaker = {
    ...NEWEST,
    messages: [
      ...NEWEST.messages,
      {
        role: 'assistant',
        text: 'Edited src/main/index.ts',
        timestamp: '2026-09-04T09:06:00Z',
        activity: { kind: 'edit', target: 'src/main/index.ts' }
      }
    ]
  }

  it('draws an edit line as a keyboard-reachable button, not an anchor, styled as text', () => {
    const wrapper = panel({ history: { readable: true, speakers: [OLDER, WITH_EDIT] } })
    const line = wrapper.find('.activity-line')
    expect(line.element.tagName).toBe('BUTTON')
    expect(line.attributes('type')).toBe('button')
    expect(line.classes()).toContain('is-openable')
  })

  it("emits the row's key and the activity's own target on click, not the display text", async () => {
    const wrapper = panel({ history: { readable: true, speakers: [OLDER, WITH_EDIT] } })
    const line = wrapper.find('.activity-line')
    await line.trigger('click')
    const [payload] = wrapper.emitted('open-path')?.[0] as [{ key: string; target: string }]
    expect(payload.target).toBe('src/main/index.ts')
  })

  it("shows main's refusal as the row's own title, in place of the display text", () => {
    const wrapper = panel({ history: { readable: true, speakers: [OLDER, WITH_EDIT] } })
    const line = wrapper.find('.activity-line')
    const key = line.attributes('data-row-key')
    const withRefusal = panel({
      history: { readable: true, speakers: [OLDER, WITH_EDIT] },
      pathRefusal: { key, reason: 'That file no longer exists.' }
    })
    expect(withRefusal.find('.activity-line').attributes('title')).toBe(
      'That file no longer exists.'
    )
  })

  it("leaves an unrelated row's title untouched by another row's refusal", () => {
    const wrapper = panel({
      history: { readable: true, speakers: [OLDER, WITH_EDIT] },
      pathRefusal: { key: 'not-this-row', reason: 'That file no longer exists.' }
    })
    expect(wrapper.find('.activity-line').attributes('title')).toBe('Edited src/main/index.ts')
  })
})

describe('MineHistoryPanel timestamp', () => {
  it("shows the selected dwarf's last-message time in the design's format, lower right", () => {
    const wrapper = panel()
    expect(wrapper.find('.history-timestamp').text()).toBe('September 04, 2026 09:05')
    expect(wrapper.find('.history-timestamp').text()).toBe(
      formatHistoryTimestamp(NEWEST.lastMessageAt)
    )
  })

  it('follows the tab', async () => {
    const wrapper = panel()
    await wrapper.findAll('.history-tab')[1]!.trigger('click')
    expect(wrapper.find('.history-timestamp').text()).toBe('September 03, 2026 18:30')
  })
})

describe('MineHistoryPanel with nothing to show', () => {
  it('says in one line that nobody has spoken in this mine yet, and draws no tab', () => {
    const wrapper = panel({ history: { readable: true, speakers: [] } })
    expect(wrapper.find('.history-empty').text()).toBe(HISTORY_EMPTY_NOTE)
    expect(wrapper.findAll('.history-tab')).toHaveLength(0)
    expect(wrapper.find('.history-timestamp').text()).toBe('')
  })

  it('says it is still reading while nothing has come back', () => {
    const wrapper = panel({ history: undefined })
    expect(wrapper.find('.history-empty').text()).toBe(HISTORY_READING_NOTE)
  })

  it('says the mine could not be read rather than that nobody spoke', () => {
    const wrapper = panel({ history: { readable: false, speakers: [] } })
    expect(wrapper.find('.history-empty').text()).toBe(HISTORY_UNREADABLE_NOTE)
  })
})

describe('MineHistoryPanel reached-start notice (#227)', () => {
  // The design source (`screens/history.md`) never asked for this notice, so
  // both its placement (top of the tab, above the scrolling transcript) and
  // its copy are the issue's own — see HISTORY_TRUNCATED_NOTE.
  it('draws the notice at the top of a tab whose read did not reach the start', () => {
    const wrapper = panel({
      history: { readable: true, speakers: [{ ...NEWEST, reachedStart: false }] }
    })
    expect(wrapper.find('.history-notice').exists()).toBe(true)
    expect(wrapper.find('.history-notice').text()).toBe(
      'This tab does not reach the start of the conversation.'
    )
  })

  it('draws no notice when the read reached the start', () => {
    const wrapper = panel({
      history: { readable: true, speakers: [{ ...NEWEST, reachedStart: true }] }
    })
    expect(wrapper.find('.history-notice').exists()).toBe(false)
  })

  it('draws no notice when the flag is absent, since absent means unknown', () => {
    const wrapper = panel({ history: { readable: true, speakers: [NEWEST] } })
    expect(wrapper.find('.history-notice').exists()).toBe(false)
  })

  it('follows the selected tab, showing only for the speaker the flag names', async () => {
    const wrapper = panel({
      history: {
        readable: true,
        speakers: [
          { ...NEWEST, reachedStart: true },
          { ...OLDER, reachedStart: false }
        ]
      }
    })
    expect(wrapper.find('.history-notice').exists()).toBe(false)

    await wrapper.findAll('.history-tab')[1]!.trigger('click')
    expect(wrapper.find('.history-notice').exists()).toBe(true)
  })
})

describe('MineHistoryPanel closing', () => {
  it('closes from its own control at the upper right', async () => {
    const wrapper = panel()
    await wrapper.find('.history-close').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('closes on Escape', async () => {
    const wrapper = panel()
    await wrapper.find('.history-panel').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('names the mine it is the history of', () => {
    expect(panel().find('.history-panel').attributes('aria-label')).toBe('History of anvil')
  })
})
