/**
 * Settings' sections (#635): seven, in place of one long scroll (screens/settings.md, W6), in the
 * design's order, listed as a vertical tablist that the up and down arrows move through, wrapping
 * at both ends (components.md, Settings, Accessibility). A section's name is also its heading.
 */
export const SETTINGS_SECTIONS = [
  'General',
  'Appearance',
  'Sound',
  'Notifications',
  'Integrations',
  'Data',
  'About'
] as const

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

const STEP: Readonly<Record<string, 1 | -1>> = { ArrowDown: 1, ArrowUp: -1 }

/** Where an arrow key moves the section tabs from `section`; undefined for any other key. */
export function steppedSection(section: SettingsSection, key: string): SettingsSection | undefined {
  const step = STEP[key]
  if (step === undefined) return undefined
  const at = SETTINGS_SECTIONS.indexOf(section)
  return SETTINGS_SECTIONS[(at + step + SETTINGS_SECTIONS.length) % SETTINGS_SECTIONS.length]
}
