// ISSUE-239 (TC-239-01): today's OpenCode launch left the tree with the 4b deletion. A path of the legacy launch tree is
// refused by R16 whether or not its file is still there: this tree holds no src/main file, so the import names a path
// that does not exist.
import { deliverViaOpenCodeContinue } from '../../main/textDelivery/opencodeContinue'

export const host = deliverViaOpenCodeContinue
