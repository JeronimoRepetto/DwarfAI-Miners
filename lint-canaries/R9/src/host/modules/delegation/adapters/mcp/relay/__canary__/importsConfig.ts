// R9-relay-only-logging-and-host-protocol: the relay shim imports contracts/logging and
// contracts/host-protocol only (deviation 5 of .dependency-cruiser.cjs), never another folder.
import { flags } from '../../../../../../../contracts/config/flags'

export const relay = flags
