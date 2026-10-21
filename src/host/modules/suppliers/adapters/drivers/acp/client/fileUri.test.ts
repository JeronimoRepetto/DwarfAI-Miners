import { describe, expect, it } from 'vitest'
import { fileUriOf } from './fileUri'

describe('fileUriOf', () => {
  it('[US-MSG-002.AC03] a POSIX path is a file URI with each segment percent-encoded', () => {
    expect(fileUriOf('/work/mine/my notes #1.txt')).toBe('file:///work/mine/my%20notes%20%231.txt')
    expect(fileUriOf('/work/mine/café.png')).toBe('file:///work/mine/caf%C3%A9.png')
  })

  it('[US-MSG-002.AC03] a POSIX file name keeps a backslash as a character, never a separator', () => {
    expect(fileUriOf('/work/mine/a\\b.txt')).toBe('file:///work/mine/a%5Cb.txt')
  })

  it('[US-MSG-002.AC03] a drive-letter path is a file URI on its drive, whatever the OS of the Host', () => {
    expect(fileUriOf('C:\\work\\mine\\a b.png')).toBe('file:///C:/work/mine/a%20b.png')
    expect(fileUriOf('d:/work/x.txt')).toBe('file:///d:/work/x.txt')
  })

  it('[US-MSG-002.AC03] a UNC path names its server as the URI host', () => {
    expect(fileUriOf('\\\\server\\share\\dir\\x.txt')).toBe('file://server/share/dir/x.txt')
  })
})
