// R9-diagnostics-only-logging: a diagnostics adapter imports contracts/logging only, never
// contracts/host-protocol (the relay's owner-approved deviation does not extend here).
import { frames } from '../../../../../contracts/host-protocol/frames'

export const log = frames
