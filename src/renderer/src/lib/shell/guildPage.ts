/*
 * The guild pages' words (#635), `organisms/guild-page` in the design: Lab, Market and Laboral
 * Union, each opening in its unavailable state — its name, its icon, and one sentence ending in
 * the same "This area is being built." (copy.md, Guild pages). Shown only once the guild flag
 * reveals the areas; the component draws these.
 */
import type { IconName } from '../icon/iconGrids'
import type { UnavailableArea } from './shellNav'
import { GUILD_SLOTS } from './panelNav'

export interface GuildPageCopy {
  name: string
  icon: IconName
  /** The whole message under "Not open yet". */
  text: string
}

const WHAT: Record<UnavailableArea, string> = {
  lab: 'Experiments with new tools and outfits for your dwarfs.',
  market: 'Trade ore for gear and skins.',
  'laboral-union': 'Rules for how your crews work and rest.'
}

export const GUILD_PAGE_HEADLINE = 'Not open yet'

export function guildPageCopy(area: UnavailableArea): GuildPageCopy {
  const slot = GUILD_SLOTS.find((one) => one.area === area)!
  return { name: slot.label, icon: slot.icon, text: WHAT[area] + ' This area is being built.' }
}
