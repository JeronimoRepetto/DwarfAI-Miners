import { describe, expect, it } from 'vitest'
import { formatViewerTokenFile, parseViewerTokenFile } from './viewerTokenFile'

const TOKEN = 'ab'.repeat(32)
const DWARF = '01920000-0000-7000-9000-0000000000a1'

describe('viewer token file', () => {
  it('[ADR-003] round-trips the token and its one dwarf', () => {
    const text = formatViewerTokenFile({ token: TOKEN, dwarfId: DWARF })
    expect(text).toBe(`${TOKEN}\n${DWARF}\n`)
    expect(parseViewerTokenFile(text)).toEqual({ token: TOKEN, dwarfId: DWARF })
  })

  it('[ADR-003] refuses anything but exactly the two lines', () => {
    for (const text of [
      '',
      TOKEN,
      `${TOKEN}\n${DWARF}`,
      `${TOKEN}\n${DWARF}\nextra\n`,
      `${TOKEN.toUpperCase()}\n${DWARF}\n`,
      `${TOKEN}0\n${DWARF}\n`,
      `${TOKEN}\nnot-a-dwarf\n`,
      `${TOKEN}\r\n${DWARF}\r\n`
    ]) {
      expect(parseViewerTokenFile(text), JSON.stringify(text)).toBeNull()
    }
  })
})
