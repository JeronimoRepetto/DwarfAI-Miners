// L1 (17 §1.1): what a folder check's reads prove (05 §3.1 "Folder check"; 07 S3.12; 13 FM-095,
// FM-096). Only a cause the OS states makes a folder missing; anything else proves nothing.
import { describe, expect, it } from 'vitest'
import { findingOfListing, findingOfStat } from './folderCheck'

describe('folder findings (07 S3.12)', () => {
  it('[S3.12, FM-095] a stat that finds a folder is present, and anything else in its place is a missing folder', () => {
    expect(findingOfStat({ isDirectory: true })).toEqual({ folder: 'present' })
    expect(findingOfStat({ isDirectory: false })).toEqual({
      folder: 'missing',
      reason: 'not-found'
    })
    expect(findingOfStat(null)).toBe('ask-listing')
  })

  it('[S3.12, FM-095, FM-096] a listing proves the folder readable, gone or unreadable, and a transient failure proves nothing', () => {
    expect(findingOfListing(null)).toEqual({ folder: 'present' })
    expect(findingOfListing('not-found')).toEqual({ folder: 'missing', reason: 'not-found' })
    expect(findingOfListing('access-denied')).toEqual({
      folder: 'missing',
      reason: 'access-denied'
    })
    expect(findingOfListing('busy')).toEqual({ folder: 'unknown' })
    expect(findingOfListing('io')).toEqual({ folder: 'unknown' })
    expect(findingOfListing('no-space')).toEqual({ folder: 'unknown' })
  })
})
