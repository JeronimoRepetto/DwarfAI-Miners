// R9-viewer-only-logging-and-host-protocol: the console viewer imports contracts/logging and
// contracts/host-protocol only (deviation 7 of .dependency-cruiser.cjs), never another folder.
import { flags } from '../../../../../../../contracts/config/flags'

export const viewer = flags
