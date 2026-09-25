import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * electron-builder reads build/icon.ico only while signing the Windows
 * executable, inside the tag-triggered `release` job — none of the checks CI
 * runs on a pull request package the app. A PNG renamed to .ico therefore
 * passes every check and fails only the Windows release leg, after Linux and
 * macOS have already published: v0.13.0 shipped with no Windows installer
 * that way ("Icon is not a valid ICO file"). This test moves that failure to
 * the pull request.
 *
 * It checks the container, not the art: an ICONDIR header (reserved 0,
 * type 1) and an entry of at least 256x256, which electron-builder requires
 * for the installer icon. A width or height byte of 0 means 256 in ICO.
 */

const iconPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'build',
  'icon.ico'
)

const HEADER_BYTES = 6
const ENTRY_BYTES = 16

function readEntrySizes(buffer) {
  const count = buffer.readUInt16LE(4)
  return Array.from({ length: count }, (_, index) => {
    const offset = HEADER_BYTES + index * ENTRY_BYTES
    return {
      width: buffer[offset] || 256,
      height: buffer[offset + 1] || 256
    }
  })
}

describe('build/icon.ico', () => {
  it('is an ICO container rather than another image format renamed', () => {
    const buffer = readFileSync(iconPath)
    expect(buffer.readUInt16LE(0)).toBe(0)
    expect(buffer.readUInt16LE(2)).toBe(1)
    expect(buffer.readUInt16LE(4)).toBeGreaterThan(0)
  })

  it('carries a 256x256 image, the size electron-builder requires', () => {
    const sizes = readEntrySizes(readFileSync(iconPath))
    expect(sizes).toContainEqual({ width: 256, height: 256 })
  })
})
