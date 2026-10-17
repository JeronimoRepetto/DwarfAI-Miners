import { describe, expect, it } from 'vitest'
import type {
  DwarfId,
  FolderPath,
  HostEpoch,
  LaunchId,
  ProviderId
} from '../../kernel/domain/values'
import type { LaunchRecord } from '../../modules/launching'
import { createResumeContextLookup } from './resumeContext'

const RECORD: LaunchRecord = {
  dwarfId: '00000000-0000-7000-8000-0000000173d1' as DwarfId,
  launchId: '00000000-0000-7000-8000-0000000173a1' as LaunchId,
  ref: { providerId: 'claude' as ProviderId, providerSessionId: 'session-1' },
  driverTransport: 'stream-json',
  cwd: '/work/deep-seam' as FolderPath,
  launchOptions: { providerId: 'claude' as ProviderId },
  launchedWithLetJevChoose: false,
  resumeIntent: true,
  stoppedByPerson: false,
  hostEpoch: 'epoch-before' as HostEpoch
}

describe('the resume-context bridge (ISSUE-173; ADR-015 items 2, 5)', () => {
  it('[S4.16, ADR-015] a stored owned session resumes in its launch folder with a spawn tag of its launch and this Host epoch', () => {
    const asked: unknown[] = []
    const lookup = createResumeContextLookup({
      owned: {
        liveRecordOfSession: (identity) => {
          asked.push(identity)
          return identity.providerSessionId === 'session-1' ? RECORD : null
        }
      },
      installId: 'install-173',
      hostEpoch: 'epoch-now' as HostEpoch
    })

    expect(
      lookup({ providerId: 'claude' as ProviderId, providerSessionId: 'session-1', pid: 7 })
    ).toEqual({
      cwd: '/work/deep-seam',
      spawnTag: `v1:install-173:${RECORD.launchId}:epoch-now`
    })
    expect(asked).toEqual([{ providerId: 'claude', providerSessionId: 'session-1' }])
    // A session launching does not own is unknown: the driver answers resume-error.
    expect(lookup({ providerId: 'claude' as ProviderId, providerSessionId: 'other' })).toBeNull()
  })
})
