// Test support: the DLL names a Windows PE image imports, read from its import and delay-import
// directories (Microsoft "PE Format": the optional header's data directories 1 and 13). Enough to
// prove the owner-only pipe helper imports no VC++ runtime; never imported by production (R14).
import { readFileSync } from 'node:fs'

export interface PeImports {
  /** The machine field of the COFF header (0x8664 x64, 0xaa64 arm64). */
  machine: number
  /** DLLs loaded with the image. */
  imports: string[]
  /** DLLs loaded on first use (`/DELAYLOAD`). */
  delayImports: string[]
}

const IMPORT_DIRECTORY = 1
const DELAY_IMPORT_DIRECTORY = 13
const IMPORT_DESCRIPTOR_BYTES = 20
const DELAY_DESCRIPTOR_BYTES = 32

export function readPeImports(path: string): PeImports {
  const image = readFileSync(path)
  if (image.readUInt16LE(0) !== 0x5a4d) throw new Error(`${path}: not an MZ image`)
  const pe = image.readUInt32LE(0x3c)
  if (image.readUInt32LE(pe) !== 0x00004550) throw new Error(`${path}: no PE signature`)
  const coff = pe + 4
  const machine = image.readUInt16LE(coff)
  const sectionCount = image.readUInt16LE(coff + 2)
  const optionalSize = image.readUInt16LE(coff + 16)
  const optional = coff + 20
  const magic = image.readUInt16LE(optional)
  // PE32+ (0x20b) keeps its data directories at 112, PE32 (0x10b) at 96.
  const directories = optional + (magic === 0x20b ? 112 : 96)
  const sections = optional + optionalSize

  const toOffset = (rva: number): number => {
    for (let index = 0; index < sectionCount; index += 1) {
      const header = sections + index * 40
      const virtualAddress = image.readUInt32LE(header + 12)
      const size = Math.max(image.readUInt32LE(header + 8), image.readUInt32LE(header + 16))
      if (rva >= virtualAddress && rva < virtualAddress + size) {
        return rva - virtualAddress + image.readUInt32LE(header + 20)
      }
    }
    throw new Error(`${path}: RVA 0x${rva.toString(16)} is in no section`)
  }
  const nameAt = (rva: number): string => {
    const start = toOffset(rva)
    return image.toString('latin1', start, image.indexOf(0, start))
  }
  const names = (directory: number, descriptorBytes: number, nameField: number): string[] => {
    const rva = image.readUInt32LE(directories + directory * 8)
    if (rva === 0) return []
    const found: string[] = []
    for (let entry = toOffset(rva); ; entry += descriptorBytes) {
      const nameRva = image.readUInt32LE(entry + nameField)
      if (nameRva === 0) return found
      found.push(nameAt(nameRva))
    }
  }

  return {
    machine,
    imports: names(IMPORT_DIRECTORY, IMPORT_DESCRIPTOR_BYTES, 12),
    delayImports: names(DELAY_IMPORT_DIRECTORY, DELAY_DESCRIPTOR_BYTES, 4)
  }
}
