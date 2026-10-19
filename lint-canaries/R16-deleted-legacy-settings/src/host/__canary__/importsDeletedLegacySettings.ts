// ISSUE-236 (TC-236-03): today's settings handlers and the settings mirror left the tree with the 4a retirement. A
// path of the legacy settings tree is refused by R16 whether or not its file is still there: this tree holds no
// src/main file, so the import names a path that does not exist.
import { createJevApiKeyStore } from '../../main/shell/jevApiKey'

export const host = createJevApiKeyStore
