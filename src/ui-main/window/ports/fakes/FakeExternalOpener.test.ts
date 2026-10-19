import { runExternalOpenerContract } from '../externalOpener.contract'
import { FakeExternalOpener } from './FakeExternalOpener'

runExternalOpenerContract('FakeExternalOpener', () => {
  const opener = new FakeExternalOpener()
  return {
    opener,
    openedLinks: () => [...opener.opened],
    openedPaths: () => [...opener.openedPaths],
    osRefusesLinks: () => {
      opener.refuse = true
    },
    osPathError: (text) => {
      opener.openPathError = text
    }
  }
})
