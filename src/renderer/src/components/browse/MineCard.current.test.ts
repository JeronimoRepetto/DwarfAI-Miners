// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UiSessionPatch } from '@dwarfai/contracts'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { followPanelMine, useView } from '../../composables/useView'
import type { MineCardView } from '../../lib/browse/mineCard'
import MineCard from './MineCard.vue'
import cardSource from './MineCard.vue?raw'
import MinesList from './MinesList.vue'

/*
 * The Panel host's current mine (OQ-73 answer A: the two Panel rules written in Valle stories ship with Valle; US-VALLE-
 * 013.AC10, US-VALLE-016.AC06; UC-060 "Panel host"; ISSUE-307). The Panel keeps its own current mine (BR-13), outside
 * machine 35: its open mine card, the one card it has focused, is the current mine, drawn with the same parchment
 * brackets as Valle's, and the one written for the Panel host through A-N18 (`useView.followPanelMine`) and played by
 * its sound engine (App's scene follows the same open mine).
 */

/** The rules of a stylesheet, comments dropped: each selector with its declarations. */
function rules(css: string): { selector: string; declarations: Map<string, string> }[] {
  const found: { selector: string; declarations: Map<string, string> }[] = []
  for (const match of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations = new Map<string, string>()
    for (const line of match[2]!.split(';')) {
      const at = line.indexOf(':')
      if (at > 0) declarations.set(line.slice(0, at).trim(), line.slice(at + 1).trim())
    }
    found.push({ selector: match[1]!.trim().replace(/\s+/g, ' '), declarations })
  }
  return found
}

const card = (name: string): MineCardView => ({
  id: name,
  name,
  tier: 'silver',
  measured: true,
  state: 'active',
  ore: [],
  crew: [],
  needs: false,
  needsCount: 0,
  enterable: true,
  removable: true
})

afterEach(() => {
  useView().clear()
})

describe("the Panel's open mine card as its current mine", () => {
  // OQ-73
  it("[US-VALLE-013.AC10] the Panel's open mine card for the current mine carries the mark 4 px thick with 16 px arms", () => {
    const open = mount(MineCard, { props: { card: card('moria'), open: true } })
    const article = open.get('article')
    expect(article.classes()).toContain('m-brackets')
    expect(article.attributes('data-open')).toBe('true')
    expect(open.get('.dm-card__hit').attributes('aria-current')).toBe('true')
    // The same mark as Valle's: `.m-brackets::after`, 4px thick by default, its arm set to 16px by the card.
    const tokens = readFileSync(join(import.meta.dirname, '../../assets/design-tokens.css'), 'utf8')
    const shared = rules(tokens).find((rule) => rule.selector === '.m-brackets::after')
    expect(shared?.declarations.get('--br-t')).toBe('4px')
    const style = cardSource.slice(cardSource.indexOf('<style'))
    const own = rules(style).find((rule) => rule.selector === '.dm-card::after')
    expect(own?.declarations.get('--br-l')).toBe('16px')
    expect(own?.declarations.has('--br-t')).toBe(false)
    // Shown by opacity alone: the open card loses no edge to a colour of its own (decision log, Selected mine mark).
    const on = rules(style).filter((rule) => rule.selector.includes("[data-open='true']"))
    expect(on.map((rule) => [...rule.declarations.keys()])).toEqual([['opacity']])
    // A card that is not the current mine draws no mark.
    const closed = mount(MineCard, { props: { card: card('erebor') } })
    expect(closed.get('article').attributes('data-open')).toBeUndefined()
    expect(closed.get('.dm-card__hit').attributes('aria-current')).toBeUndefined()
  })

  // OQ-73
  it('[US-VALLE-016.AC06] with several mine cards open in the Panel the current mine follows focused equals current', async () => {
    const patches: UiSessionPatch[] = []
    const stop = followPanelMine(
      {
        getUiSession: () => Promise.reject(new Error('unused')),
        patchUiSession: (patch) => patches.push(patch)
      },
      { onMineArrival: () => () => {} }
    )
    const view = useView()
    const list = mount(MinesList, {
      props: {
        cards: [card('moria'), card('erebor'), card('khazad')],
        openId: view.state.mineId,
        search: '',
        tier: null,
        sort: 'name' as const
      }
    })
    const marked = (): string[] =>
      list.findAll('article[data-open="true"]').map((article) => article.attributes('data-mine')!)

    // The card the person focuses is the current mine: marked, written for the Panel host, and nothing else marked.
    for (const mineId of ['erebor', 'khazad']) {
      await list.get(`article[data-mine="${mineId}"] .dm-card__hit`).trigger('click')
      expect(list.emitted('open')?.at(-1)).toEqual([mineId])
      view.openMine(mineId)
      await list.setProps({ openId: view.state.mineId })
      await nextTick()
      expect(marked()).toEqual([mineId])
      expect(patches.at(-1)).toEqual({ kind: 'current-mine', host: 'panel', mineId })
    }
    stop()
  })
})
